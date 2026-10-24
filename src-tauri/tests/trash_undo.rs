use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

static DATABASE: OnceLock<PathBuf> = OnceLock::new();
static LIBRARY: Mutex<&str> = Mutex::new("undo-test");

mod t_config {
    pub fn current_library_id() -> Result<String, String> {
        Ok(super::LIBRARY.lock().unwrap().to_string())
    }
}
mod t_storage {
    pub fn get_current_db_path() -> Result<String, String> {
        Ok(super::DATABASE
            .get()
            .unwrap()
            .to_string_lossy()
            .into_owned())
    }
}
mod t_sqlite {
    pub fn open_conn() -> Result<rusqlite::Connection, String> {
        let conn = rusqlite::Connection::open(super::DATABASE.get().unwrap())
            .map_err(|error| error.to_string())?;
        conn.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;")
            .map_err(|error| error.to_string())?;
        Ok(conn)
    }
}
mod t_cmds {
    pub fn with_current_library<T>(
        library: &str,
        operation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        if super::t_config::current_library_id()? != library {
            return Err("Library changed".into());
        }
        operation()
    }
}

#[path = "../src/t_trash_undo.rs"]
mod t_trash_undo;

#[test]
#[ignore = "Moves only disposable test files through the real OS Recycle Bin"]
fn recycle_and_restore_catalog_safely() {
    let root = std::env::temp_dir().join(format!("lap-trash-undo-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    DATABASE.set(root.join("catalog.db")).unwrap();
    let conn = t_sqlite::open_conn().unwrap();
    conn.execute_batch("CREATE TABLE afolders(id INTEGER PRIMARY KEY, path TEXT);
        CREATE TABLE afiles(id INTEGER PRIMARY KEY, folder_id INTEGER REFERENCES afolders(id) ON DELETE CASCADE, name TEXT, rating INTEGER, comments TEXT);
        CREATE TABLE atags(id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE afile_tags(file_id INTEGER REFERENCES afiles(id) ON DELETE CASCADE, tag_id INTEGER REFERENCES atags(id), PRIMARY KEY(file_id,tag_id));
        CREATE TABLE acollections_files(collection_id INTEGER, file_id INTEGER REFERENCES afiles(id) ON DELETE CASCADE, PRIMARY KEY(collection_id,file_id));
        CREATE TABLE duplicate_groups(id INTEGER PRIMARY KEY, hash TEXT);
        CREATE TABLE duplicate_group_items(group_id INTEGER REFERENCES duplicate_groups(id) ON DELETE CASCADE, file_id INTEGER REFERENCES afiles(id) ON DELETE CASCADE, PRIMARY KEY(group_id,file_id));
        INSERT INTO atags VALUES(1,'keep-tag');").unwrap();
    conn.execute(
        "INSERT INTO afolders VALUES(1,?1)",
        [root.to_str().unwrap()],
    )
    .unwrap();
    for (id, name) in [(1, "first.jpg"), (2, "second.mov"), (3, "failed.jpg")] {
        std::fs::write(root.join(name), name.as_bytes()).unwrap();
        conn.execute(
            "INSERT INTO afiles VALUES(?1,1,?2,5,'keep-comment')",
            rusqlite::params![id, name],
        )
        .unwrap();
        conn.execute("INSERT INTO afile_tags VALUES(?1,1)", [id])
            .unwrap();
        conn.execute("INSERT INTO acollections_files VALUES(7,?1)", [id])
            .unwrap();
    }
    let first = root.join("first.jpg");
    let second = root.join("second.mov");
    let failed = root.join("failed.jpg");
    conn.execute_batch("INSERT INTO duplicate_groups VALUES(9,'keep-hash'); INSERT INTO duplicate_group_items VALUES(9,1);").unwrap();
    t_trash_undo::record(
        "undo-test",
        [1, 2, 3].into(),
        None,
        vec![first.clone(), second.clone(), failed.clone()],
        || {
            trash::delete(&first).map_err(|error| error.to_string())?;
            trash::delete(&second).map_err(|error| error.to_string())?;
            conn.execute("DELETE FROM afiles WHERE id IN (1,2)", [])
                .unwrap();
            conn.execute("DELETE FROM duplicate_groups WHERE id=9", [])
                .unwrap();
            Ok(())
        },
    )
    .unwrap();
    assert!(!first.exists() && !second.exists() && failed.exists());
    *LIBRARY.lock().unwrap() = "other-library";
    assert!(!t_trash_undo::undo("other-library").unwrap());
    assert!(t_trash_undo::undo("undo-test").is_err());
    *LIBRARY.lock().unwrap() = "undo-test";
    std::fs::write(&first, b"do not overwrite").unwrap();
    assert!(
        t_trash_undo::undo("undo-test")
            .unwrap_err()
            .contains("already exists")
    );
    assert!(!second.exists());
    assert_eq!(std::fs::read(&first).unwrap(), b"do not overwrite");
    std::fs::remove_file(&first).unwrap();
    assert!(t_trash_undo::undo("undo-test").unwrap());
    assert_eq!(std::fs::read(&first).unwrap(), b"first.jpg");
    assert_eq!(std::fs::read(&second).unwrap(), b"second.mov");
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM afiles WHERE rating=5 AND comments='keep-comment'",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        3
    );
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM afile_tags", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        3
    );
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM acollections_files", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        3
    );
    assert!(!t_trash_undo::undo("undo-test").unwrap());
    assert_eq!(
        conn.query_row("SELECT hash FROM duplicate_groups WHERE id=9", [], |row| {
            row.get::<_, String>(0)
        })
        .unwrap(),
        "keep-hash"
    );
    assert_eq!(
        conn.query_row(
            "SELECT file_id FROM duplicate_group_items WHERE group_id=9",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    let folder = root.join("folder_100%");
    std::fs::create_dir(&folder).unwrap();
    std::fs::write(folder.join("nested.jpg"), b"nested").unwrap();
    std::fs::create_dir(folder.join("uncataloged")).unwrap();
    std::fs::write(folder.join("uncataloged/extra.txt"), b"extra").unwrap();
    conn.execute(
        "INSERT INTO afolders VALUES(2,?1)",
        [folder.to_str().unwrap()],
    )
    .unwrap();
    conn.execute("INSERT INTO afiles VALUES(4,2,'nested.jpg',4,'folder')", [])
        .unwrap();
    t_trash_undo::record(
        "undo-test",
        [].into(),
        Some(folder.to_str().unwrap()),
        vec![folder.clone()],
        || {
            trash::delete(&folder).map_err(|error| error.to_string())?;
            conn.execute("DELETE FROM afolders WHERE id=2", []).unwrap();
            Ok(())
        },
    )
    .unwrap();
    assert!(t_trash_undo::undo("undo-test").unwrap());
    assert_eq!(std::fs::read(folder.join("nested.jpg")).unwrap(), b"nested");
    assert_eq!(
        std::fs::read(folder.join("uncataloged/extra.txt")).unwrap(),
        b"extra"
    );
    assert_eq!(
        conn.query_row("SELECT rating FROM afiles WHERE id=4", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        4
    );
    let partial: Result<(), String> = t_trash_undo::record(
        "undo-test",
        [].into(),
        Some(folder.to_str().unwrap()),
        vec![folder.clone()],
        || {
            trash::delete(folder.join("nested.jpg")).map_err(|error| error.to_string())?;
            conn.execute("DELETE FROM afiles WHERE id=4", []).unwrap();
            Err("simulated partial folder failure".into())
        },
    );
    assert!(partial.is_err());
    assert!(folder.exists());
    assert!(t_trash_undo::undo("undo-test").unwrap());
    assert_eq!(std::fs::read(folder.join("nested.jpg")).unwrap(), b"nested");
    t_trash_undo::record("undo-test", [1].into(), None, vec![first.clone()], || {
        trash::delete(&first).map_err(|error| error.to_string())?;
        conn.execute("DELETE FROM afiles WHERE id=1", []).unwrap();
        Ok(())
    })
    .unwrap();
    conn.execute(
        "INSERT INTO afiles VALUES(1,1,'conflict.jpg',0,'unrelated')",
        [],
    )
    .unwrap();
    assert!(
        t_trash_undo::undo("undo-test")
            .unwrap_err()
            .contains("Catalog conflict")
    );
    assert!(first.exists());
    assert_eq!(
        conn.query_row("SELECT comments FROM afiles WHERE id=1", [], |row| row
            .get::<_, String>(
            0
        ))
        .unwrap(),
        "unrelated"
    );
    conn.execute("DELETE FROM afiles WHERE id=1", []).unwrap();
    assert!(t_trash_undo::undo("undo-test").unwrap());
    assert_eq!(
        conn.query_row("SELECT rating FROM afiles WHERE id=1", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        5
    );
    drop(conn);
    std::fs::remove_dir_all(&root).unwrap();
}
