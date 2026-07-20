use std::io;
use std::path::Path;

pub fn copy_if_different(source: &Path, destination: &Path) -> io::Result<bool> {
    let source_contents = std::fs::read(source)?;
    match std::fs::read(destination) {
        Ok(destination_contents) if destination_contents == source_contents => return Ok(false),
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }

    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::copy(source, destination)?;
    Ok(true)
}
