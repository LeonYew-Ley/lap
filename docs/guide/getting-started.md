# Getting Started

## Installation

### macOS with Homebrew (Apple Silicon / Intel)

```bash
brew tap julyx10/lap
brew install --cask lap
```

### macOS Manual Install (Apple Silicon / Intel)

1.  Download the latest `_aarch64.dmg` or `_x64.dmg` file from the [Releases page](https://github.com/julyx10/lap/releases/latest).
2.  Open the disk image and drag **Lap** to your **Applications** folder.
3.  Double-click to launch.

### Linux (Ubuntu/Debian/Linux Mint, amd64 / arm64)

1. Download the latest `_amd64.deb` or `_arm64.deb` package from the [Releases page](https://github.com/julyx10/lap/releases).
2. Install it with your package manager or run `sudo apt install ./Lap_0.3.3_amd64.deb` (x64) or `sudo apt install ./Lap_0.3.3_arm64.deb` (ARM64).
3. Launch **Lap** from your applications menu.

For better video playback support on Ubuntu/Debian/Linux Mint, install:

```bash
sudo apt install gstreamer1.0-libav gstreamer1.0-plugins-good
```

### Linux AppImage (x64 / ARM64)

1. Download the `_amd64.AppImage` (x64) or `_aarch64.AppImage` (ARM64) file from the [latest release](https://github.com/julyx10/lap/releases/latest).
2. Make it executable in your file manager, or run `chmod +x Lap_0.3.3_amd64.AppImage` using the filename you downloaded.
3. Double-click the AppImage to launch Lap.

The AppImage uses system multimedia libraries for video playback. On Ubuntu/Debian/Linux Mint, install the GStreamer packages listed above.

### Fedora

Check the community [COPR repository](https://copr.fedorainfracloud.org/coprs/beneedict/lap/) for Fedora packages and installation instructions. New builds may become available later than the main release downloads.

### Windows 10/11 (x64 / ARM64)

1. Download the latest `_x64_en-US.msi` or `_arm64_en-US.msi` installer from the [Releases page](https://github.com/julyx10/lap/releases/latest).
2. Run the installer and complete the setup wizard.
3. Launch **Lap** from the Start menu or desktop shortcut.

Lap's Windows installer is currently unsigned. If Microsoft SmartScreen blocks the download or installer, choose **Keep anyway** or **More info** > **Run anyway**.

## First Run

When you open Lap for the first time:

1.  **Grant Permissions**: Lap needs access to your folders to display photos.
2.  **Add an Album**: Add a folder containing your photos to your library.
3.  **Let it Index**: Lap will scan your files, generate thumbnails, and build local search data. This happens on your device.

## Import and Explore

- Use **Import…** from an album's context menu to copy media into date-organized folders while preserving filenames and skipping duplicate content.
- Switch between **Grid**, **Filmstrip**, and **Map** from the main toolbar. Use **Map View** to explore geotagged media matching your current filters. Map tiles require an internet connection.
- Adjust thumbnail quality and the RAW thumbnail source in **Settings → Advanced**.
- Organize tags into groups and use the multi-select panel for batch actions.
- Create a **Photo Collage** from selected photos, choose a layout, and export or print the result.
- Browse cached thumbnails and metadata for offline albums; reconnect the storage for actions that need the original files.
- Use RAW preview badges to switch modes or select the paired JPEG/HEIC.

## Deleting Files

- **Delete / Move to Trash** moves files or folders to the system Trash or Recycle Bin. The confirmation dialog does not offer permanent deletion.
- Confirmation is enabled by default. Check **Do not ask again** and confirm to skip future trash confirmations, including after restarting Lap. Canceling the dialog leaves the preference unchanged.
- To restore confirmation, enable **Confirm before moving files or folders to Trash** in **Settings → General**.
- On Windows and Linux, press **Ctrl+Z** outside text fields and dialogs to undo the most recent trash operation, including a multi-file batch or folder. Lap restores the originals and their catalog metadata (including ratings, tags and collection membership). Up to 20 operations are retained for the current app session, scoped to each library. Restarting Lap clears this undo history; files remain recoverable through the system trash. macOS trash undo is not implemented yet.
- Undo refuses to overwrite an existing path. If a name conflict or restore error occurs, resolve the conflict and retry; Lap keeps the operation available until it completes. Items removed from the system trash cannot be recovered by Lap.
- If a location does not support the system trash, Lap reports a failure and leaves the affected files in place. Restore trashed files or empty the trash using your operating system.

## Updating Lap

On macOS and Windows, use the built-in updater or install the latest package over your existing installation. For Linux DEB installations, install the latest matching DEB package with your package manager.

For AppImage installations, download the new AppImage instead of using the built-in updater. AppImage packages include embedded update information and companion `.zsync` files for delta updates through compatible external tools such as AppImageUpdate.

See the [v0.3.3 release notes](/guide/release-notes/v0.3.3) for the latest changes.
