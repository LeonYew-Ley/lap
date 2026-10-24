use rusqlite::{Connection, params_from_iter, types::Value};
use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Clone)]
struct Rows {
    table: String,
    columns: Vec<String>,
    values: Vec<Vec<Value>>,
}

impl Rows {
    fn read(conn: &Connection, table: &str, predicate: &str) -> Result<Self, String> {
        let mut statement = conn
            .prepare(&format!("SELECT * FROM {table} WHERE {predicate}"))
            .map_err(|error| error.to_string())?;
        let columns = statement
            .column_names()
            .iter()
            .map(|name| name.to_string())
            .collect::<Vec<_>>();
        let values = statement
            .query_map([], |row| {
                (0..columns.len())
                    .map(|index| row.get(index))
                    .collect::<rusqlite::Result<Vec<Value>>>()
            })
            .map_err(|error| error.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| error.to_string())?;
        Ok(Self {
            table: table.into(),
            columns,
            values,
        })
    }

    fn retain(&mut self, column: &str, ids: &HashSet<i64>) {
        let index = self.columns.iter().position(|name| name == column).unwrap();
        self.values
            .retain(|row| matches!(row[index], Value::Integer(id) if ids.contains(&id)));
    }

    fn restore(&self, conn: &Connection) -> Result<(), String> {
        let placeholders = vec!["?"; self.columns.len()].join(",");
        let sql = format!(
            "INSERT INTO {} ({}) VALUES ({placeholders}) ON CONFLICT DO NOTHING",
            self.table,
            self.columns.join(",")
        );
        for row in &self.values {
            if conn
                .execute(&sql, params_from_iter(row))
                .map_err(|error| error.to_string())?
                == 0
            {
                let predicate = self
                    .columns
                    .iter()
                    .map(|name| format!("{name} IS ?"))
                    .collect::<Vec<_>>()
                    .join(" AND ");
                let identical: bool = conn
                    .query_row(
                        &format!(
                            "SELECT EXISTS(SELECT 1 FROM {} WHERE {predicate})",
                            self.table
                        ),
                        params_from_iter(row),
                        |result| result.get(0),
                    )
                    .map_err(|error| error.to_string())?;
                if !identical
                    && !matches!(
                        self.table.as_str(),
                        "duplicate_groups" | "similarity_groups" | "similarity_scans"
                    )
                {
                    return Err(format!(
                        "Catalog conflict in {}; nothing was overwritten",
                        self.table
                    ));
                }
            }
        }
        Ok(())
    }
}

fn id_list(ids: &HashSet<i64>) -> String {
    if ids.is_empty() {
        "NULL".into()
    } else {
        ids.iter().map(i64::to_string).collect::<Vec<_>>().join(",")
    }
}

struct Snapshot {
    tables: Vec<Rows>,
}

impl Snapshot {
    fn capture(
        conn: &Connection,
        files: &HashSet<i64>,
        folders: &HashSet<i64>,
    ) -> Result<Self, String> {
        let file_ids = id_list(files);
        let folder_ids = id_list(folders);
        let mut tables = Vec::new();
        for (table, predicate) in [
            ("afolders", format!("id IN ({folder_ids})")),
            ("afiles", format!("id IN ({file_ids})")),
            (
                "duplicate_groups",
                format!(
                    "id IN (SELECT group_id FROM duplicate_group_items WHERE file_id IN ({file_ids}))"
                ),
            ),
            (
                "similarity_scans",
                format!(
                    "id IN (SELECT scan_id FROM similarity_groups WHERE id IN (SELECT group_id FROM similarity_group_items WHERE file_id IN ({file_ids})))"
                ),
            ),
            (
                "similarity_groups",
                format!(
                    "id IN (SELECT group_id FROM similarity_group_items WHERE file_id IN ({file_ids}))"
                ),
            ),
            ("athumbs", format!("file_id IN ({file_ids})")),
            ("afile_tags", format!("file_id IN ({file_ids})")),
            ("acollections_files", format!("file_id IN ({file_ids})")),
            ("faces", format!("file_id IN ({file_ids})")),
            ("file_hashes", format!("file_id IN ({file_ids})")),
            ("duplicate_group_items", format!("file_id IN ({file_ids})")),
            ("similarity_group_items", format!("file_id IN ({file_ids})")),
            ("folder_scan_state", format!("folder_id IN ({folder_ids})")),
        ] {
            let exists: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                    [table],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())?;
            if exists {
                tables.push(Rows::read(conn, table, &predicate)?);
            }
        }
        Ok(Self { tables })
    }

    fn retain_files(&mut self, ids: &HashSet<i64>) {
        for rows in &mut self.tables {
            if rows.table == "afiles" {
                rows.retain("id", ids);
            } else if rows.columns.iter().any(|column| column == "file_id") {
                rows.retain("file_id", ids);
            }
        }
    }

    fn restore(&self, conn: &mut Connection) -> Result<(), String> {
        let transaction = conn.transaction().map_err(|error| error.to_string())?;
        for rows in &self.tables {
            rows.restore(&transaction)?;
        }
        transaction.commit().map_err(|error| error.to_string())
    }

    fn retain_missing_folders(&mut self) {
        let mut ids = HashSet::new();
        if let Some(folders) = self.tables.iter_mut().find(|rows| rows.table == "afolders") {
            let path_index = folders
                .columns
                .iter()
                .position(|column| column == "path")
                .unwrap();
            let id_index = folders
                .columns
                .iter()
                .position(|column| column == "id")
                .unwrap();
            folders.values.retain(|row| match &row[path_index] {
                Value::Text(path) => !Path::new(path).exists(),
                _ => false,
            });
            for row in &folders.values {
                if let Value::Integer(id) = row[id_index] {
                    ids.insert(id);
                }
            }
        }
        for rows in &mut self.tables {
            if rows.table == "folder_scan_state" {
                rows.retain("folder_id", &ids);
            }
        }
    }
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
mod supported {
    use super::*;
    use trash::TrashItem;

    struct RestorePath {
        path: PathBuf,
        item: Option<TrashItem>,
        restored: bool,
    }

    struct Batch {
        library: String,
        database: PathBuf,
        snapshot: Snapshot,
        paths: Vec<RestorePath>,
        files: Vec<PathBuf>,
    }

    static HISTORY: Mutex<VecDeque<Batch>> = Mutex::new(VecDeque::new());

    pub(super) fn record<T>(
        library: &str,
        file_ids: HashSet<i64>,
        folder: Option<&str>,
        paths: Vec<PathBuf>,
        operation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        crate::t_cmds::with_current_library(library, || {
            let mut history = HISTORY.lock().map_err(|error| error.to_string())?;
            let database = PathBuf::from(crate::t_storage::get_current_db_path()?);
            let conn = crate::t_sqlite::open_conn()?;
            let mut folders = HashSet::new();
            let mut files = file_ids;
            if let Some(folder) = folder {
                let mut statement = conn
                    .prepare("SELECT id, path FROM afolders")
                    .map_err(|error| error.to_string())?;
                let candidates = statement
                    .query_map([], |row| {
                        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                    })
                    .map_err(|error| error.to_string())?;
                for candidate in candidates {
                    let (id, path) = candidate.map_err(|error| error.to_string())?;
                    if Path::new(&path).starts_with(folder) {
                        folders.insert(id);
                    }
                }
                let mut statement = conn
                    .prepare(&format!(
                        "SELECT id FROM afiles WHERE folder_id IN ({})",
                        id_list(&folders)
                    ))
                    .map_err(|error| error.to_string())?;
                files.extend(
                    statement
                        .query_map([], |row| row.get::<_, i64>(0))
                        .map_err(|error| error.to_string())?
                        .collect::<rusqlite::Result<Vec<_>>>()
                        .map_err(|error| error.to_string())?,
                );
            }
            let mut snapshot = Snapshot::capture(&conn, &files, &folders)?;
            let file_paths = {
                let mut statement = conn.prepare(&format!("SELECT a.id, f.path, a.name FROM afiles a JOIN afolders f ON a.folder_id=f.id WHERE a.id IN ({})", id_list(&files))).map_err(|error| error.to_string())?;
                statement
                    .query_map([], |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            PathBuf::from(row.get::<_, String>(1)?).join(row.get::<_, String>(2)?),
                        ))
                    })
                    .map_err(|error| error.to_string())?
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .map_err(|error| error.to_string())?
            };
            let before = trash::os_limited::list()
                .map_err(|error| format!("Cannot prepare trash undo: {error}"))?
                .into_iter()
                .map(|item| item.id)
                .collect::<HashSet<_>>();
            let existing = paths
                .into_iter()
                .filter(|path| path.exists())
                .collect::<HashSet<_>>();
            let result = operation();
            let mut removed = existing
                .into_iter()
                .filter(|path| !path.exists())
                .collect::<HashSet<_>>();
            let entries = trash::os_limited::list().unwrap_or_default();
            if let Some(folder) = folder {
                for item in &entries {
                    let path = item.original_path();
                    if !before.contains(&item.id) && path.starts_with(folder) && !path.exists() {
                        removed.insert(path);
                    }
                }
            }
            if !removed.is_empty() {
                let deleted = file_paths
                    .iter()
                    .filter(|(_, path)| !path.exists())
                    .map(|(id, _)| *id)
                    .collect();
                snapshot.retain_files(&deleted);
                snapshot.retain_missing_folders();
                let files = file_paths
                    .into_iter()
                    .filter(|(id, _)| deleted.contains(id))
                    .map(|(_, path)| path)
                    .collect();
                let mut paths = removed
                    .into_iter()
                    .map(|path| {
                        let matches = entries
                            .iter()
                            .filter(|item| {
                                !before.contains(&item.id) && item.original_path() == path
                            })
                            .collect::<Vec<_>>();
                        let item = if matches.len() == 1 {
                            Some(matches[0].clone())
                        } else {
                            None
                        };
                        RestorePath {
                            path,
                            item,
                            restored: false,
                        }
                    })
                    .collect::<Vec<_>>();
                paths.sort_by(|left, right| {
                    left.path
                        .components()
                        .count()
                        .cmp(&right.path.components().count())
                        .then_with(|| left.path.cmp(&right.path))
                });
                history.push_back(Batch {
                    library: library.to_string(),
                    database,
                    snapshot,
                    paths,
                    files,
                });
                while history.len() > 20 {
                    history.pop_front();
                }
            }
            result
        })
    }

    pub(super) fn undo(library: &str) -> Result<bool, String> {
        crate::t_cmds::with_current_library(library, || {
            let mut history = HISTORY.lock().map_err(|error| error.to_string())?;
            let database = PathBuf::from(crate::t_storage::get_current_db_path()?);
            let Some(index) = history
                .iter()
                .rposition(|batch| batch.library == library && batch.database == database)
            else {
                return Ok(false);
            };
            let batch = &mut history[index];
            let mut conn = crate::t_sqlite::open_conn()?;
            let entries = trash::os_limited::list().map_err(|error| error.to_string())?;
            for target in &batch.paths {
                if target.restored {
                    if !target.path.exists() {
                        return Err(format!(
                            "Restored path is no longer available: {}",
                            target.path.display()
                        ));
                    }
                    continue;
                }
                if target.path.exists() {
                    return Err(format!(
                        "Cannot undo: path already exists; nothing was overwritten: {}",
                        target.path.display()
                    ));
                }
                let item = target.item.as_ref().ok_or_else(|| format!("Cannot identify the exact recycled item: {}. Restore it from the system Recycle Bin.", target.path.display()))?;
                if !entries
                    .iter()
                    .any(|entry| entry.id == item.id && entry.original_path() == target.path)
                {
                    return Err(format!(
                        "Item is no longer in the Recycle Bin: {}",
                        target.path.display()
                    ));
                }
            }
            for target in &mut batch.paths {
                if target.restored {
                    continue;
                }
                let result = trash::os_limited::restore_all([target.item.clone().unwrap()]);
                target.restored = target.path.exists();
                result.map_err(|error| error.to_string())?;
                if !target.restored {
                    return Err(format!(
                        "Restore did not complete: {}",
                        target.path.display()
                    ));
                }
            }
            if let Some(missing) = batch.files.iter().find(|path| !path.exists()) {
                return Err(format!(
                    "Not all originals were restored: {}",
                    missing.display()
                ));
            }
            batch.snapshot.restore(&mut conn)?;
            history.remove(index);
            Ok(true)
        })
    }
}

pub(crate) fn record<T>(
    library: &str,
    files: HashSet<i64>,
    folder: Option<&str>,
    paths: Vec<PathBuf>,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        supported::record(library, files, folder, paths, operation)
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        let _ = (library, files, folder, paths);
        operation()
    }
}

pub(crate) fn undo(library: &str) -> Result<bool, String> {
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        supported::undo(library)
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        let _ = library;
        Err("Trash undo is not supported on this platform yet".into())
    }
}
