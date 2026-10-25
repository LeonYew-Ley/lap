use std::cell::RefCell;
use std::ffi::OsString;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use trash::TrashItem;
use windows::Win32::Foundation::{E_ABORT, RPC_E_CHANGED_MODE};
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
    CoTaskMemFree, CoUninitialize,
};
use windows::Win32::System::SystemServices::SFGAO_VALIDATE;
use windows::Win32::UI::Shell::*;
use windows::core::{HRESULT, PCWSTR, Ref, implement};

thread_local! {
    static RECEIPTS: RefCell<Option<Vec<TrashItem>>> = const { RefCell::new(None) };
}

pub(super) struct Capture;

impl Capture {
    pub(super) fn start() -> Result<Self, String> {
        RECEIPTS.with(|receipts| {
            let mut receipts = receipts.borrow_mut();
            if receipts.is_some() {
                return Err("A recycle operation is already active on this thread".into());
            }
            *receipts = Some(Vec::new());
            Ok(Self)
        })
    }

    pub(super) fn finish(self) -> Vec<TrashItem> {
        RECEIPTS.with(|receipts| receipts.borrow_mut().take().unwrap_or_default())
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        RECEIPTS.with(|receipts| receipts.borrow_mut().take());
    }
}

struct Apartment(bool);

impl Apartment {
    fn new() -> windows::core::Result<Self> {
        let result = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        if result == RPC_E_CHANGED_MODE {
            return Ok(Self(false));
        }
        result.ok()?;
        Ok(Self(true))
    }
}

impl Drop for Apartment {
    fn drop(&mut self) {
        if self.0 {
            unsafe { CoUninitialize() };
        }
    }
}

fn display_name(item: &IShellItem, kind: SIGDN) -> windows::core::Result<OsString> {
    unsafe {
        let name = item.GetDisplayName(kind)?;
        let owned = OsString::from_wide(name.as_wide());
        CoTaskMemFree(Some(name.0.cast()));
        Ok(owned)
    }
}

pub(super) fn validate(item: &TrashItem) -> Result<(), String> {
    let _apartment = Apartment::new().map_err(|error| error.to_string())?;
    let wide = item.id.encode_wide().chain(Some(0)).collect::<Vec<_>>();
    unsafe {
        let recycled: IShellItem = SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None)
            .map_err(|error| error.to_string())?;
        recycled
            .GetAttributes(SFGAO_VALIDATE)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[derive(Default)]
struct Outcome {
    items: Vec<TrashItem>,
    error: Option<String>,
}

#[implement(IFileOperationProgressSink)]
struct RecycleSink {
    outcome: Arc<Mutex<Outcome>>,
}

#[allow(non_snake_case)]
impl IFileOperationProgressSink_Impl for RecycleSink_Impl {
    fn StartOperations(&self) -> windows::core::Result<()> {
        Ok(())
    }
    fn FinishOperations(&self, _result: HRESULT) -> windows::core::Result<()> {
        Ok(())
    }
    fn PreRenameItem(
        &self,
        _flags: u32,
        _item: Ref<IShellItem>,
        _name: &PCWSTR,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn PostRenameItem(
        &self,
        _flags: u32,
        _item: Ref<IShellItem>,
        _name: &PCWSTR,
        _result: HRESULT,
        _created: Ref<IShellItem>,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn PreMoveItem(
        &self,
        _flags: u32,
        _item: Ref<IShellItem>,
        _folder: Ref<IShellItem>,
        _name: &PCWSTR,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn PostMoveItem(
        &self,
        _flags: u32,
        _item: Ref<IShellItem>,
        _folder: Ref<IShellItem>,
        _name: &PCWSTR,
        _result: HRESULT,
        _created: Ref<IShellItem>,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn PreCopyItem(
        &self,
        _flags: u32,
        _item: Ref<IShellItem>,
        _folder: Ref<IShellItem>,
        _name: &PCWSTR,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn PostCopyItem(
        &self,
        _flags: u32,
        _item: Ref<IShellItem>,
        _folder: Ref<IShellItem>,
        _name: &PCWSTR,
        _result: HRESULT,
        _created: Ref<IShellItem>,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn PreDeleteItem(&self, flags: u32, _item: Ref<IShellItem>) -> windows::core::Result<()> {
        if flags & TSF_DELETE_RECYCLE_IF_POSSIBLE.0 as u32 == 0 {
            return Err(windows::core::Error::new(
                E_ABORT,
                "Permanent deletion is not allowed",
            ));
        }
        Ok(())
    }
    fn PostDeleteItem(
        &self,
        _flags: u32,
        item: Ref<IShellItem>,
        result: HRESULT,
        created: Ref<IShellItem>,
    ) -> windows::core::Result<()> {
        let receipt = (|| -> Result<TrashItem, String> {
            result.ok().map_err(|error| error.to_string())?;
            let original = item.as_ref().ok_or("Missing original recycle item")?;
            let recycled = created
                .as_ref()
                .ok_or("Windows did not return a recycled item")?;
            let path = PathBuf::from(
                display_name(original, SIGDN_FILESYSPATH).map_err(|error| error.to_string())?,
            );
            Ok(TrashItem {
                id: display_name(recycled, SIGDN_DESKTOPABSOLUTEPARSING)
                    .map_err(|error| error.to_string())?,
                name: path
                    .file_name()
                    .ok_or("Missing recycled file name")?
                    .to_string_lossy()
                    .into_owned(),
                original_parent: path
                    .parent()
                    .ok_or("Missing recycled file parent")?
                    .to_path_buf(),
                time_deleted: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64,
            })
        })();
        let mut outcome = self
            .outcome
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        match receipt {
            Ok(item) => outcome.items.push(item),
            Err(error) => outcome.error = Some(error),
        }
        Ok(())
    }
    fn PreNewItem(
        &self,
        _flags: u32,
        _folder: Ref<IShellItem>,
        _name: &PCWSTR,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn PostNewItem(
        &self,
        _flags: u32,
        _folder: Ref<IShellItem>,
        _name: &PCWSTR,
        _template: &PCWSTR,
        _attributes: u32,
        _result: HRESULT,
        _created: Ref<IShellItem>,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn UpdateProgress(&self, _total: u32, _completed: u32) -> windows::core::Result<()> {
        Ok(())
    }
    fn ResetTimer(&self) -> windows::core::Result<()> {
        Ok(())
    }
    fn PauseTimer(&self) -> windows::core::Result<()> {
        Ok(())
    }
    fn ResumeTimer(&self) -> windows::core::Result<()> {
        Ok(())
    }
}

pub(super) fn recycle(path: &str) -> Result<(), String> {
    let _apartment = Apartment::new().map_err(|error| error.to_string())?;
    let path = Path::new(path);
    let name = path.file_name().ok_or("Cannot recycle a filesystem root")?;
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let absolute = parent
        .canonicalize()
        .map_err(|error| error.to_string())?
        .join(name);
    let absolute = absolute.to_string_lossy();
    let shell_path = if let Some(network) = absolute.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{network}")
    } else {
        absolute
            .strip_prefix(r"\\?\")
            .unwrap_or(&absolute)
            .to_string()
    };
    let wide = std::ffi::OsStr::new(&shell_path)
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let outcome = Arc::new(Mutex::new(Outcome::default()));
    let sink: IFileOperationProgressSink = RecycleSink {
        outcome: outcome.clone(),
    }
    .into();
    let result = unsafe {
        (|| -> windows::core::Result<()> {
            let operation: IFileOperation =
                CoCreateInstance(&FileOperation, None, CLSCTX_INPROC_SERVER)?;
            operation.SetOperationFlags(
                FOF_SILENT
                    | FOF_NOCONFIRMATION
                    | FOF_NOERRORUI
                    | FOF_NOCONFIRMMKDIR
                    | FOF_ALLOWUNDO
                    | FOF_WANTNUKEWARNING
                    | FOFX_RECYCLEONDELETE,
            )?;
            let item: IShellItem = SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None)?;
            operation.DeleteItem(&item, &sink)?;
            operation.PerformOperations()?;
            if operation.GetAnyOperationsAborted()?.as_bool() {
                return Err(windows::core::Error::new(
                    E_ABORT,
                    "Recycle operation was cancelled",
                ));
            }
            Ok(())
        })()
    };
    let mut outcome = outcome.lock().map_err(|error| error.to_string())?;
    RECEIPTS.with(|receipts| {
        if let Some(receipts) = receipts.borrow_mut().as_mut() {
            receipts.append(&mut outcome.items);
        }
    });
    result.map_err(|error| error.to_string())?;
    if let Some(error) = outcome.error.take() {
        return Err(error);
    }
    if path.exists() {
        return Err(format!("Path was not recycled: {}", path.display()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn receipt_capture_rejects_nested_scopes_and_resets_on_drop() {
        let capture = Capture::start().unwrap();
        assert!(Capture::start().is_err());
        drop(capture);
        assert!(Capture::start().unwrap().finish().is_empty());
    }

    #[test]
    fn receipt_capture_finishes_without_leaking_to_the_next_operation() {
        let capture = Capture::start().unwrap();
        RECEIPTS.with(|receipts| {
            receipts.borrow_mut().as_mut().unwrap().push(TrashItem {
                id: "receipt-test".into(),
                name: "photo.jpg".into(),
                original_parent: PathBuf::from("C:/test"),
                time_deleted: 0,
            })
        });
        assert_eq!(capture.finish().len(), 1);
        assert!(Capture::start().unwrap().finish().is_empty());
    }
}
