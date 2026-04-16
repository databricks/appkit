use pyo3::prelude::*;
use reqwest::Client;
use serde::Deserialize;

/// Maximum file read size in bytes (10 MB), matching TS FILES_MAX_READ_SIZE.
const FILES_MAX_READ_SIZE: usize = 10 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Internal serde types for Databricks Files API responses
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct DirectoryListResponse {
    #[serde(default)]
    contents: Vec<DirectoryEntryRaw>,
    next_page_token: Option<String>,
}

#[derive(Deserialize)]
struct DirectoryEntryRaw {
    path: Option<String>,
    name: Option<String>,
    is_directory: Option<bool>,
    file_size: Option<u64>,
    last_modified: Option<u64>,
}

// ---------------------------------------------------------------------------
// Python-facing response types (frozen / immutable)
// ---------------------------------------------------------------------------

/// A single entry in a directory listing.
#[pyclass(frozen, module = "appkit")]
#[derive(Clone)]
pub struct FileDirectoryEntry {
    #[pyo3(get)]
    pub path: String,
    #[pyo3(get)]
    pub name: String,
    #[pyo3(get)]
    pub is_directory: bool,
    #[pyo3(get)]
    pub file_size: Option<u64>,
    #[pyo3(get)]
    pub last_modified: Option<u64>,
}

#[pymethods]
impl FileDirectoryEntry {
    fn __repr__(&self) -> String {
        format!(
            "FileDirectoryEntry(name={:?}, is_directory={})",
            self.name, self.is_directory
        )
    }

    fn __eq__(&self, other: &Self) -> bool {
        self.path == other.path && self.name == other.name && self.is_directory == other.is_directory
    }

    fn __hash__(&self) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        self.path.hash(&mut hasher);
        self.name.hash(&mut hasher);
        self.is_directory.hash(&mut hasher);
        hasher.finish()
    }
}

/// File metadata from a HEAD request.
#[pyclass(frozen, module = "appkit")]
#[derive(Clone)]
pub struct FileMetadata {
    #[pyo3(get)]
    pub content_length: Option<u64>,
    #[pyo3(get)]
    pub content_type: Option<String>,
    #[pyo3(get)]
    pub last_modified: Option<String>,
}

#[pymethods]
impl FileMetadata {
    fn __repr__(&self) -> String {
        format!(
            "FileMetadata(content_type={:?}, content_length={:?})",
            self.content_type, self.content_length
        )
    }
}

/// File preview with optional text content.
#[pyclass(frozen, module = "appkit")]
#[derive(Clone)]
pub struct FilePreview {
    #[pyo3(get)]
    pub content_length: Option<u64>,
    #[pyo3(get)]
    pub content_type: Option<String>,
    #[pyo3(get)]
    pub last_modified: Option<String>,
    #[pyo3(get)]
    pub text_preview: Option<String>,
    #[pyo3(get)]
    pub is_text: bool,
    #[pyo3(get)]
    pub is_image: bool,
}

#[pymethods]
impl FilePreview {
    fn __repr__(&self) -> String {
        format!(
            "FilePreview(content_type={:?}, is_text={}, is_image={})",
            self.content_type, self.is_text, self.is_image
        )
    }
}

// ---------------------------------------------------------------------------
// Path validation helpers
// ---------------------------------------------------------------------------

fn validate_and_resolve_path(
    file_path: &str,
    default_volume: Option<&str>,
) -> Result<String, String> {
    if file_path.len() > 4096 {
        return Err(format!(
            "Path exceeds maximum length of 4096 characters (got {}).",
            file_path.len()
        ));
    }
    if file_path.contains('\0') {
        return Err("Path must not contain null bytes.".into());
    }
    if file_path.split('/').any(|s| s == "..") {
        return Err("Path traversal (\"../\") is not allowed.".into());
    }

    if file_path.starts_with('/') {
        if !file_path.starts_with("/Volumes/") {
            return Err(
                "Absolute paths must start with \"/Volumes/\". \
                 Unity Catalog volume paths follow the format: /Volumes/<catalog>/<schema>/<volume>/"
                    .into(),
            );
        }
        return Ok(file_path.to_string());
    }

    match default_volume {
        Some(vol) => Ok(format!("{}/{}", vol, file_path)),
        None => Err(
            "Cannot resolve relative path: no default volume set. \
             Use an absolute path or set a default volume."
                .into(),
        ),
    }
}

/// Returns true if the content type is text-like.
fn is_text_content_type(content_type: &str) -> bool {
    if content_type.starts_with("text/") {
        return true;
    }
    const TEXT_KEYWORDS: &[&str] = &["json", "xml", "yaml", "sql", "javascript"];
    TEXT_KEYWORDS.iter().any(|kw| content_type.contains(kw))
}

// ---------------------------------------------------------------------------
// FilesConnector
// ---------------------------------------------------------------------------

/// Databricks Files API connector.
///
/// Provides file/directory operations against Unity Catalog volumes using
/// the REST API at `/api/2.0/fs/`. Auth tokens are passed per-call so both
/// service-principal and OBO flows are supported.
#[pyclass(module = "appkit")]
pub struct FilesConnector {
    host: String,
    default_volume: Option<String>,
    http: Client,
}

#[pymethods]
impl FilesConnector {
    #[new]
    #[pyo3(signature = (host, *, default_volume = None))]
    fn new(host: String, default_volume: Option<String>) -> Self {
        Self {
            host: host.trim_end_matches('/').to_string(),
            default_volume,
            http: Client::new(),
        }
    }

    /// Validate and resolve a file path, applying the default volume if needed.
    #[pyo3(signature = (file_path))]
    fn resolve_path(&self, file_path: &str) -> PyResult<String> {
        validate_and_resolve_path(file_path, self.default_volume.as_deref())
            .map_err(pyo3::exceptions::PyValueError::new_err)
    }

    /// List contents of a directory.
    #[pyo3(signature = (token, *, directory_path = None))]
    fn list<'py>(
        &self,
        py: Python<'py>,
        token: String,
        directory_path: Option<String>,
    ) -> PyResult<Bound<'py, PyAny>> {
        let resolved = match directory_path {
            Some(ref p) => validate_and_resolve_path(p, self.default_volume.as_deref()),
            None => self
                .default_volume
                .clone()
                .ok_or_else(|| "No directory path provided and no default volume set.".to_string()),
        }
        .map_err(pyo3::exceptions::PyValueError::new_err)?;

        let http = self.http.clone();
        let host = self.host.clone();

        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let mut all_entries = Vec::new();
            let mut page_token: Option<String> = None;

            loop {
                let mut url = format!("{}/api/2.0/fs/directories{}", host, resolved);
                if let Some(ref tok) = page_token {
                    url = format!("{}?page_token={}", url, tok);
                }

                let resp = http
                    .get(&url)
                    .bearer_auth(&token)
                    .send()
                    .await
                    .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(e.to_string()))?;

                if !resp.status().is_success() {
                    let status = resp.status();
                    let body = resp.text().await.unwrap_or_default();
                    return Err(pyo3::exceptions::PyRuntimeError::new_err(format!(
                        "List directory failed ({status}): {body}"
                    )));
                }

                let data: DirectoryListResponse = resp
                    .json()
                    .await
                    .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(e.to_string()))?;

                for raw in data.contents {
                    all_entries.push(FileDirectoryEntry {
                        path: raw.path.unwrap_or_default(),
                        name: raw.name.unwrap_or_default(),
                        is_directory: raw.is_directory.unwrap_or(false),
                        file_size: raw.file_size,
                        last_modified: raw.last_modified,
                    });
                }

                match data.next_page_token {
                    Some(tok) if !tok.is_empty() => page_token = Some(tok),
                    _ => break,
                }
            }

            Ok(all_entries)
        })
    }

    /// Read a file as a UTF-8 string.
    #[pyo3(signature = (token, file_path, *, max_size = None))]
    fn read<'py>(
        &self,
        py: Python<'py>,
        token: String,
        file_path: String,
        max_size: Option<usize>,
    ) -> PyResult<Bound<'py, PyAny>> {
        let resolved = validate_and_resolve_path(&file_path, self.default_volume.as_deref())
            .map_err(pyo3::exceptions::PyValueError::new_err)?;
        let max = max_size.unwrap_or(FILES_MAX_READ_SIZE);
        let http = self.http.clone();
        let host = self.host.clone();

        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let url = format!("{}/api/2.0/fs/files{}", host, resolved);
            let resp = http
                .get(&url)
                .bearer_auth(&token)
                .send()
                .await
                .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(e.to_string()))?;

            if !resp.status().is_success() {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                return Err(pyo3::exceptions::PyRuntimeError::new_err(format!(
                    "Read file failed ({status}): {body}"
                )));
            }

            let bytes = resp
                .bytes()
                .await
                .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(e.to_string()))?;

            if bytes.len() > max {
                return Err(pyo3::exceptions::PyRuntimeError::new_err(format!(
                    "File exceeds maximum read size ({max} bytes). Use download() for large files."
                )));
            }

            String::from_utf8(bytes.to_vec()).map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!(
                    "File is not valid UTF-8: {e}"
                ))
            })
        })
    }

    /// Download a file as raw bytes.
    #[pyo3(signature = (token, file_path))]
    fn download<'py>(
        &self,
        py: Python<'py>,
        token: String,
        file_path: String,
    ) -> PyResult<Bound<'py, PyAny>> {
        let resolved = validate_and_resolve_path(&file_path, self.default_volume.as_deref())
            .map_err(pyo3::exceptions::PyValueError::new_err)?;
        let http = self.http.clone();
        let host = self.host.clone();

        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let url = format!("{}/api/2.0/fs/files{}", host, resolved);
            let resp = http
                .get(&url)
                .bearer_auth(&token)
                .send()
                .await
                .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(e.to_string()))?;

            if !resp.status().is_success() {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                return Err(pyo3::exceptions::PyRuntimeError::new_err(format!(
                    "Download failed ({status}): {body}"
                )));
            }

            let bytes = resp
                .bytes()
                .await
                .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(e.to_string()))?;

            Ok(bytes.to_vec())
        })
    }

    /// Check if a file exists.
    #[pyo3(signature = (token, file_path))]
    fn exists<'py>(
        &self,
        py: Python<'py>,
        token: String,
        file_path: String,
    ) -> PyResult<Bound<'py, PyAny>> {
        let resolved = validate_and_resolve_path(&file_path, self.default_volume.as_deref())
            .map_err(pyo3::exceptions::PyValueError::new_err)?;
        let http = self.http.clone();
        let host = self.host.clone();

        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let url = format!("{}/api/2.0/fs/files{}", host, resolved);
            let resp = http
                .head(&url)
                .bearer_auth(&token)
                .send()
                .await
                .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(e.to_string()))?;

            Ok(resp.status().is_success())
        })
    }

    /// Get file metadata via HEAD request.
    #[pyo3(signature = (token, file_path))]
    fn metadata<'py>(
        &self,
        py: Python<'py>,
        token: String,
        file_path: String,
    ) -> PyResult<Bound<'py, PyAny>> {
        let resolved = validate_and_resolve_path(&file_path, self.default_volume.as_deref())
            .map_err(pyo3::exceptions::PyValueError::new_err)?;
        let http = self.http.clone();
        let host = self.host.clone();

        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let url = format!("{}/api/2.0/fs/files{}", host, resolved);
            let resp = http
                .head(&url)
                .bearer_auth(&token)
                .send()
                .await
                .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(e.to_string()))?;

            if !resp.status().is_success() {
                let status = resp.status();
                return Err(pyo3::exceptions::PyRuntimeError::new_err(format!(
                    "Metadata request failed ({status})"
                )));
            }

            let headers = resp.headers();
            let content_length = headers
                .get("content-length")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok());
            let content_type = headers
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string());
            let last_modified = headers
                .get("last-modified")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string());

            Ok(FileMetadata {
                content_length,
                content_type,
                last_modified,
            })
        })
    }

    /// Upload file contents. Defaults to overwrite=True.
    #[pyo3(signature = (token, file_path, contents, *, overwrite = true))]
    fn upload<'py>(
        &self,
        py: Python<'py>,
        token: String,
        file_path: String,
        contents: Vec<u8>,
        overwrite: bool,
    ) -> PyResult<Bound<'py, PyAny>> {
        let resolved = validate_and_resolve_path(&file_path, self.default_volume.as_deref())
            .map_err(pyo3::exceptions::PyValueError::new_err)?;
        let http = self.http.clone();
        let host = self.host.clone();

        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let url = format!(
                "{}/api/2.0/fs/files{}?overwrite={}",
                host, resolved, overwrite
            );
            let resp = http
                .put(&url)
                .bearer_auth(&token)
                .header("Content-Type", "application/octet-stream")
                .body(contents)
                .send()
                .await
                .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(e.to_string()))?;

            if !resp.status().is_success() {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                return Err(pyo3::exceptions::PyRuntimeError::new_err(format!(
                    "Upload failed ({status}): {body}"
                )));
            }

            Ok(())
        })
    }

    /// Create a directory.
    #[pyo3(signature = (token, directory_path))]
    fn create_directory<'py>(
        &self,
        py: Python<'py>,
        token: String,
        directory_path: String,
    ) -> PyResult<Bound<'py, PyAny>> {
        let resolved = validate_and_resolve_path(&directory_path, self.default_volume.as_deref())
            .map_err(pyo3::exceptions::PyValueError::new_err)?;
        let http = self.http.clone();
        let host = self.host.clone();

        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let url = format!("{}/api/2.0/fs/directories{}", host, resolved);
            let resp = http
                .put(&url)
                .bearer_auth(&token)
                .send()
                .await
                .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(e.to_string()))?;

            if !resp.status().is_success() {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                return Err(pyo3::exceptions::PyRuntimeError::new_err(format!(
                    "Create directory failed ({status}): {body}"
                )));
            }

            Ok(())
        })
    }

    /// Delete a file.
    #[pyo3(signature = (token, file_path))]
    fn delete<'py>(
        &self,
        py: Python<'py>,
        token: String,
        file_path: String,
    ) -> PyResult<Bound<'py, PyAny>> {
        let resolved = validate_and_resolve_path(&file_path, self.default_volume.as_deref())
            .map_err(pyo3::exceptions::PyValueError::new_err)?;
        let http = self.http.clone();
        let host = self.host.clone();

        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let url = format!("{}/api/2.0/fs/files{}", host, resolved);
            let resp = http
                .delete(&url)
                .bearer_auth(&token)
                .send()
                .await
                .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(e.to_string()))?;

            if !resp.status().is_success() {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                return Err(pyo3::exceptions::PyRuntimeError::new_err(format!(
                    "Delete failed ({status}): {body}"
                )));
            }

            Ok(())
        })
    }

    /// Get file preview with optional text content.
    #[pyo3(signature = (token, file_path, *, max_chars = 1024))]
    fn preview<'py>(
        &self,
        py: Python<'py>,
        token: String,
        file_path: String,
        max_chars: usize,
    ) -> PyResult<Bound<'py, PyAny>> {
        let resolved = validate_and_resolve_path(&file_path, self.default_volume.as_deref())
            .map_err(pyo3::exceptions::PyValueError::new_err)?;
        let http = self.http.clone();
        let host = self.host.clone();

        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            // 1. HEAD for metadata
            let meta_url = format!("{}/api/2.0/fs/files{}", host, resolved);
            let head_resp = http
                .head(&meta_url)
                .bearer_auth(&token)
                .send()
                .await
                .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(e.to_string()))?;

            if !head_resp.status().is_success() {
                let status = head_resp.status();
                return Err(pyo3::exceptions::PyRuntimeError::new_err(format!(
                    "Preview metadata failed ({status})"
                )));
            }

            let headers = head_resp.headers();
            let content_length = headers
                .get("content-length")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok());
            let content_type = headers
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string());
            let last_modified = headers
                .get("last-modified")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string());

            let ct = content_type.as_deref().unwrap_or("");
            let is_text = is_text_content_type(ct);
            let is_image = ct.starts_with("image/");

            if !is_text {
                return Ok(FilePreview {
                    content_length,
                    content_type,
                    last_modified,
                    text_preview: None,
                    is_text: false,
                    is_image,
                });
            }

            // 2. GET the file for text preview
            let get_resp = http
                .get(&meta_url)
                .bearer_auth(&token)
                .send()
                .await
                .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(e.to_string()))?;

            if !get_resp.status().is_success() {
                return Ok(FilePreview {
                    content_length,
                    content_type,
                    last_modified,
                    text_preview: Some(String::new()),
                    is_text: true,
                    is_image: false,
                });
            }

            let bytes = get_resp
                .bytes()
                .await
                .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(e.to_string()))?;

            let full_text = String::from_utf8_lossy(&bytes);
            let preview = if full_text.len() > max_chars {
                full_text[..max_chars].to_string()
            } else {
                full_text.into_owned()
            };

            Ok(FilePreview {
                content_length,
                content_type,
                last_modified,
                text_preview: Some(preview),
                is_text: true,
                is_image: false,
            })
        })
    }

    fn __repr__(&self) -> String {
        format!(
            "FilesConnector(host={:?}, default_volume={:?})",
            self.host, self.default_volume
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resolve_absolute_volumes_path() {
        let result =
            validate_and_resolve_path("/Volumes/catalog/schema/vol/file.txt", None);
        assert_eq!(result.unwrap(), "/Volumes/catalog/schema/vol/file.txt");
    }

    #[test]
    fn test_resolve_absolute_non_volumes_rejected() {
        let result = validate_and_resolve_path("/etc/passwd", None);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("/Volumes/"));
    }

    #[test]
    fn test_resolve_relative_with_default_volume() {
        let result = validate_and_resolve_path(
            "subdir/file.txt",
            Some("/Volumes/catalog/schema/vol"),
        );
        assert_eq!(
            result.unwrap(),
            "/Volumes/catalog/schema/vol/subdir/file.txt"
        );
    }

    #[test]
    fn test_resolve_relative_without_default_volume() {
        let result = validate_and_resolve_path("file.txt", None);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("default volume"));
    }

    #[test]
    fn test_path_traversal_rejected() {
        let result = validate_and_resolve_path(
            "/Volumes/catalog/schema/vol/../../../etc/passwd",
            None,
        );
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("traversal"));
    }

    #[test]
    fn test_null_byte_rejected() {
        let result = validate_and_resolve_path("/Volumes/cat/sch/vol/f\0ile.txt", None);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("null"));
    }

    #[test]
    fn test_path_too_long() {
        let long_path = format!("/Volumes/{}", "a".repeat(4097));
        let result = validate_and_resolve_path(&long_path, None);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("4096"));
    }

    #[test]
    fn test_is_text_content_type() {
        assert!(is_text_content_type("text/plain"));
        assert!(is_text_content_type("text/html"));
        assert!(is_text_content_type("application/json"));
        assert!(is_text_content_type("application/xml"));
        assert!(is_text_content_type("application/x-yaml"));
        assert!(is_text_content_type("application/sql"));
        assert!(is_text_content_type("application/javascript"));
        assert!(!is_text_content_type("image/png"));
        assert!(!is_text_content_type("application/octet-stream"));
    }
}
