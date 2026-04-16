use pyo3::prelude::*;
use reqwest::Client;
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Defaults matching TS genieConnectorDefaults
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS: u64 = 120_000;
const DEFAULT_MAX_MESSAGES: usize = 200;
const DEFAULT_INITIAL_PAGE_SIZE: u32 = 20;
const DEFAULT_PAGE_SIZE: u32 = 100;
const DEFAULT_POLL_INTERVAL_MS: u64 = 3_000;

// ---------------------------------------------------------------------------
// Internal serde types for Databricks Genie API
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct StartConversationBody {
    content: String,
}

#[derive(Serialize)]
struct CreateMessageBody {
    content: String,
}

#[derive(Deserialize, Debug)]
struct StartConversationResponse {
    conversation_id: Option<String>,
    message_id: Option<String>,
}

#[derive(Deserialize, Debug)]
struct CreateMessageResponse {
    message_id: Option<String>,
}

#[derive(Deserialize, Debug, Clone)]
struct GenieMessageRaw {
    message_id: Option<String>,
    conversation_id: Option<String>,
    space_id: Option<String>,
    status: Option<String>,
    content: Option<String>,
    #[serde(default)]
    attachments: Option<Vec<GenieAttachmentRaw>>,
    error: Option<GenieErrorRaw>,
}

#[derive(Deserialize, Debug, Clone)]
struct GenieAttachmentRaw {
    attachment_id: Option<String>,
    query: Option<GenieQueryRaw>,
    text: Option<GenieTextRaw>,
    suggested_questions: Option<GenieQuestionsRaw>,
}

#[derive(Deserialize, Debug, Clone)]
struct GenieQueryRaw {
    title: Option<String>,
    description: Option<String>,
    query: Option<String>,
    statement_id: Option<String>,
}

#[derive(Deserialize, Debug, Clone)]
struct GenieTextRaw {
    content: Option<String>,
}

#[derive(Deserialize, Debug, Clone)]
struct GenieQuestionsRaw {
    questions: Option<Vec<String>>,
}

#[derive(Deserialize, Debug, Clone)]
struct GenieErrorRaw {
    error: Option<String>,
}

#[derive(Deserialize, Debug)]
struct ListMessagesResponse {
    #[serde(default)]
    messages: Vec<GenieMessageRaw>,
    next_page_token: Option<String>,
}

#[derive(Deserialize, Debug)]
struct QueryResultWrapper {
    statement_response: Option<serde_json::Value>,
}

// ---------------------------------------------------------------------------
// Python-facing response types (frozen / immutable)
// ---------------------------------------------------------------------------

/// Genie query attachment metadata.
#[pyclass(frozen, module = "appkit")]
#[derive(Clone)]
pub struct GenieAttachment {
    #[pyo3(get)]
    pub attachment_id: Option<String>,
    #[pyo3(get)]
    pub query_title: Option<String>,
    #[pyo3(get)]
    pub query_description: Option<String>,
    #[pyo3(get)]
    pub query_sql: Option<String>,
    #[pyo3(get)]
    pub query_statement_id: Option<String>,
    #[pyo3(get)]
    pub text_content: Option<String>,
    #[pyo3(get)]
    pub suggested_questions: Option<Vec<String>>,
}

#[pymethods]
impl GenieAttachment {
    fn __repr__(&self) -> String {
        format!(
            "GenieAttachment(attachment_id={:?}, statement_id={:?})",
            self.attachment_id, self.query_statement_id
        )
    }
}

impl GenieAttachment {
    fn from_raw(raw: &GenieAttachmentRaw) -> Self {
        Self {
            attachment_id: raw.attachment_id.clone(),
            query_title: raw.query.as_ref().and_then(|q| q.title.clone()),
            query_description: raw.query.as_ref().and_then(|q| q.description.clone()),
            query_sql: raw.query.as_ref().and_then(|q| q.query.clone()),
            query_statement_id: raw.query.as_ref().and_then(|q| q.statement_id.clone()),
            text_content: raw.text.as_ref().and_then(|t| t.content.clone()),
            suggested_questions: raw
                .suggested_questions
                .as_ref()
                .and_then(|sq| sq.questions.clone()),
        }
    }
}

/// Genie message response.
#[pyclass(frozen, module = "appkit")]
#[derive(Clone)]
pub struct GenieMessage {
    #[pyo3(get)]
    pub message_id: String,
    #[pyo3(get)]
    pub conversation_id: String,
    #[pyo3(get)]
    pub space_id: String,
    #[pyo3(get)]
    pub status: String,
    #[pyo3(get)]
    pub content: String,
    #[pyo3(get)]
    pub attachments: Vec<GenieAttachment>,
    #[pyo3(get)]
    pub error: Option<String>,
}

#[pymethods]
impl GenieMessage {
    fn __repr__(&self) -> String {
        format!(
            "GenieMessage(message_id={:?}, status={:?})",
            self.message_id, self.status
        )
    }
}

impl GenieMessage {
    fn from_raw(raw: &GenieMessageRaw) -> Self {
        Self {
            message_id: raw.message_id.clone().unwrap_or_default(),
            conversation_id: raw.conversation_id.clone().unwrap_or_default(),
            space_id: raw.space_id.clone().unwrap_or_default(),
            status: raw.status.clone().unwrap_or_else(|| "COMPLETED".into()),
            content: raw.content.clone().unwrap_or_default(),
            attachments: raw
                .attachments
                .as_ref()
                .map(|atts| atts.iter().map(GenieAttachment::from_raw).collect())
                .unwrap_or_default(),
            error: raw.error.as_ref().and_then(|e| e.error.clone()),
        }
    }
}

/// Full conversation history.
#[pyclass(frozen, module = "appkit")]
#[derive(Clone)]
pub struct GenieConversationHistory {
    #[pyo3(get)]
    pub conversation_id: String,
    #[pyo3(get)]
    pub space_id: String,
    #[pyo3(get)]
    pub messages: Vec<GenieMessage>,
}

#[pymethods]
impl GenieConversationHistory {
    fn __repr__(&self) -> String {
        format!(
            "GenieConversationHistory(conversation_id={:?}, message_count={})",
            self.conversation_id,
            self.messages.len()
        )
    }

    fn __len__(&self) -> usize {
        self.messages.len()
    }
}

/// Query result from a Genie attachment (statement_response).
#[pyclass(frozen, module = "appkit")]
#[derive(Clone)]
pub struct GenieQueryResult {
    /// Raw JSON of the statement_response.
    #[pyo3(get)]
    pub data: String,
}

#[pymethods]
impl GenieQueryResult {
    fn __repr__(&self) -> String {
        let len = self.data.len().min(80);
        format!("GenieQueryResult(data={:?}...)", &self.data[..len])
    }
}

// ---------------------------------------------------------------------------
// Error classification — mirrors TS classifyGenieError
// ---------------------------------------------------------------------------

fn classify_error(msg: &str) -> String {
    if msg.contains("RESOURCE_DOES_NOT_EXIST") {
        return "You don't have access to this Genie Space.".into();
    }
    if msg.contains("failed to reach COMPLETED state") && msg.contains("FAILED") {
        return "You may not have access to the data tables. Please verify your table permissions."
            .into();
    }
    if msg.is_empty() {
        return "Genie request failed".into();
    }
    msg.to_string()
}

// ---------------------------------------------------------------------------
// GenieConnector
// ---------------------------------------------------------------------------

/// Databricks Genie connector.
///
/// Provides conversation/message operations, attachment fetching, and
/// polling for Genie AI query results via the REST API.
#[pyclass(module = "appkit")]
pub struct GenieConnector {
    host: String,
    timeout_ms: u64,
    max_messages: usize,
    http: Client,
}

impl GenieConnector {
    fn base_url(&self, space_id: &str) -> String {
        format!("{}/api/2.0/genie/spaces/{}", self.host, space_id)
    }

    /// Poll GET message until terminal state (COMPLETED/FAILED).
    async fn poll_message(
        &self,
        token: &str,
        space_id: &str,
        conversation_id: &str,
        message_id: &str,
        timeout_ms: u64,
    ) -> Result<GenieMessage, String> {
        let start = std::time::Instant::now();

        loop {
            let elapsed = start.elapsed().as_millis() as u64;
            if elapsed > timeout_ms {
                return Err(format!(
                    "Genie message polling timed out after {timeout_ms}ms"
                ));
            }

            tokio::time::sleep(std::time::Duration::from_millis(DEFAULT_POLL_INTERVAL_MS)).await;

            let url = format!(
                "{}/conversations/{}/messages/{}",
                self.base_url(space_id),
                conversation_id,
                message_id,
            );

            let resp = self
                .http
                .get(&url)
                .bearer_auth(token)
                .send()
                .await
                .map_err(|e| format!("Poll message failed: {e}"))?;

            if !resp.status().is_success() {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                return Err(format!("Poll message ({status}): {body}"));
            }

            let raw: GenieMessageRaw = resp
                .json()
                .await
                .map_err(|e| format!("Parse message failed: {e}"))?;

            let state = raw.status.as_deref().unwrap_or("");
            if state == "COMPLETED" || state == "FAILED" {
                return Ok(GenieMessage::from_raw(&raw));
            }
        }
    }

    /// Fetch a page of messages (internal).
    async fn list_messages_internal(
        &self,
        token: &str,
        space_id: &str,
        conversation_id: &str,
        page_size: u32,
        page_token: Option<&str>,
    ) -> Result<(Vec<GenieMessage>, Option<String>), String> {
        let mut url = format!(
            "{}/conversations/{}/messages?page_size={}",
            self.base_url(space_id),
            conversation_id,
            page_size,
        );
        if let Some(pt) = page_token {
            url = format!("{}&page_token={}", url, pt);
        }

        let resp = self
            .http
            .get(&url)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|e| format!("List messages failed: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("List messages ({status}): {body}"));
        }

        let data: ListMessagesResponse = resp
            .json()
            .await
            .map_err(|e| format!("Parse list response: {e}"))?;

        // Reverse to chronological order (API returns newest first)
        let messages: Vec<GenieMessage> = data
            .messages
            .iter()
            .rev()
            .map(GenieMessage::from_raw)
            .collect();

        let next = data
            .next_page_token
            .filter(|t| !t.is_empty());

        Ok((messages, next))
    }
}

#[pymethods]
impl GenieConnector {
    #[new]
    #[pyo3(signature = (host, *, timeout_ms = None, max_messages = None))]
    fn new(host: String, timeout_ms: Option<u64>, max_messages: Option<usize>) -> Self {
        Self {
            host: host.trim_end_matches('/').to_string(),
            timeout_ms: timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS),
            max_messages: max_messages.unwrap_or(DEFAULT_MAX_MESSAGES),
            http: Client::new(),
        }
    }

    /// Start a new conversation or add a message to an existing one.
    /// Returns (conversation_id, message_id).
    #[pyo3(signature = (token, space_id, content, *, conversation_id = None))]
    fn start_message<'py>(
        &self,
        py: Python<'py>,
        token: String,
        space_id: String,
        content: String,
        conversation_id: Option<String>,
    ) -> PyResult<Bound<'py, PyAny>> {
        let http = self.http.clone();
        let base = self.base_url(&space_id);

        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            if let Some(ref conv_id) = conversation_id {
                // Add message to existing conversation
                let url = format!("{}/conversations/{}/messages", base, conv_id);
                let resp = http
                    .post(&url)
                    .bearer_auth(&token)
                    .json(&CreateMessageBody {
                        content: content.clone(),
                    })
                    .send()
                    .await
                    .map_err(|e| {
                        pyo3::exceptions::PyRuntimeError::new_err(format!(
                            "Create message failed: {e}"
                        ))
                    })?;

                if !resp.status().is_success() {
                    let status = resp.status();
                    let body = resp.text().await.unwrap_or_default();
                    return Err(pyo3::exceptions::PyRuntimeError::new_err(
                        classify_error(&format!("Create message ({status}): {body}")),
                    ));
                }

                let data: CreateMessageResponse = resp.json().await.map_err(|e| {
                    pyo3::exceptions::PyRuntimeError::new_err(format!("Parse response: {e}"))
                })?;

                Ok((
                    conv_id.clone(),
                    data.message_id.unwrap_or_default(),
                ))
            } else {
                // Start new conversation
                let url = format!("{}/start-conversation", base);
                let resp = http
                    .post(&url)
                    .bearer_auth(&token)
                    .json(&StartConversationBody {
                        content: content.clone(),
                    })
                    .send()
                    .await
                    .map_err(|e| {
                        pyo3::exceptions::PyRuntimeError::new_err(format!(
                            "Start conversation failed: {e}"
                        ))
                    })?;

                if !resp.status().is_success() {
                    let status = resp.status();
                    let body = resp.text().await.unwrap_or_default();
                    return Err(pyo3::exceptions::PyRuntimeError::new_err(
                        classify_error(&format!("Start conversation ({status}): {body}")),
                    ));
                }

                let data: StartConversationResponse = resp.json().await.map_err(|e| {
                    pyo3::exceptions::PyRuntimeError::new_err(format!("Parse response: {e}"))
                })?;

                Ok((
                    data.conversation_id.unwrap_or_default(),
                    data.message_id.unwrap_or_default(),
                ))
            }
        })
    }

    /// Send a message and wait for the completed response.
    #[pyo3(signature = (token, space_id, content, *, conversation_id = None, timeout_ms = None))]
    fn send_message<'py>(
        &self,
        py: Python<'py>,
        token: String,
        space_id: String,
        content: String,
        conversation_id: Option<String>,
        timeout_ms: Option<u64>,
    ) -> PyResult<Bound<'py, PyAny>> {
        let http = self.http.clone();
        let base = self.base_url(&space_id);
        let timeout = timeout_ms.unwrap_or(self.timeout_ms);
        let host = self.host.clone();
        let connector_timeout = self.timeout_ms;

        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            // Start message
            let (conv_id, msg_id) = if let Some(ref existing_conv) = conversation_id {
                let url = format!("{}/conversations/{}/messages", base, existing_conv);
                let resp = http
                    .post(&url)
                    .bearer_auth(&token)
                    .json(&CreateMessageBody {
                        content: content.clone(),
                    })
                    .send()
                    .await
                    .map_err(|e| {
                        pyo3::exceptions::PyRuntimeError::new_err(classify_error(&e.to_string()))
                    })?;

                if !resp.status().is_success() {
                    let status = resp.status();
                    let body = resp.text().await.unwrap_or_default();
                    return Err(pyo3::exceptions::PyRuntimeError::new_err(classify_error(
                        &format!("{status}: {body}"),
                    )));
                }

                let data: CreateMessageResponse = resp.json().await.map_err(|e| {
                    pyo3::exceptions::PyRuntimeError::new_err(e.to_string())
                })?;
                (existing_conv.clone(), data.message_id.unwrap_or_default())
            } else {
                let url = format!("{}/start-conversation", base);
                let resp = http
                    .post(&url)
                    .bearer_auth(&token)
                    .json(&StartConversationBody {
                        content: content.clone(),
                    })
                    .send()
                    .await
                    .map_err(|e| {
                        pyo3::exceptions::PyRuntimeError::new_err(classify_error(&e.to_string()))
                    })?;

                if !resp.status().is_success() {
                    let status = resp.status();
                    let body = resp.text().await.unwrap_or_default();
                    return Err(pyo3::exceptions::PyRuntimeError::new_err(classify_error(
                        &format!("{status}: {body}"),
                    )));
                }

                let data: StartConversationResponse = resp.json().await.map_err(|e| {
                    pyo3::exceptions::PyRuntimeError::new_err(e.to_string())
                })?;
                (
                    data.conversation_id.unwrap_or_default(),
                    data.message_id.unwrap_or_default(),
                )
            };

            // Create a temporary connector for polling
            let tmp = GenieConnector {
                host: host.clone(),
                timeout_ms: connector_timeout,
                max_messages: 0,
                http: http.clone(),
            };

            // Poll until completed
            tmp.poll_message(&token, &space_id, &conv_id, &msg_id, timeout)
                .await
                .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(classify_error(&e)))
        })
    }

    /// Get a single message by ID, polling until terminal state.
    #[pyo3(signature = (token, space_id, conversation_id, message_id, *, timeout_ms = None))]
    fn get_message<'py>(
        &self,
        py: Python<'py>,
        token: String,
        space_id: String,
        conversation_id: String,
        message_id: String,
        timeout_ms: Option<u64>,
    ) -> PyResult<Bound<'py, PyAny>> {
        let http = self.http.clone();
        let base = self.base_url(&space_id);
        let timeout = timeout_ms.unwrap_or(self.timeout_ms);

        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            // First check current state
            let url = format!(
                "{}/conversations/{}/messages/{}",
                base, conversation_id, message_id
            );
            let resp = http
                .get(&url)
                .bearer_auth(&token)
                .send()
                .await
                .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(e.to_string()))?;

            if !resp.status().is_success() {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                return Err(pyo3::exceptions::PyRuntimeError::new_err(classify_error(
                    &format!("{status}: {body}"),
                )));
            }

            let raw: GenieMessageRaw = resp
                .json()
                .await
                .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(e.to_string()))?;

            let state = raw.status.as_deref().unwrap_or("");
            if state == "COMPLETED" || state == "FAILED" {
                return Ok(GenieMessage::from_raw(&raw));
            }

            // Poll until terminal
            let start = std::time::Instant::now();
            loop {
                let elapsed = start.elapsed().as_millis() as u64;
                if elapsed > timeout {
                    return Err(pyo3::exceptions::PyRuntimeError::new_err(format!(
                        "Message polling timed out after {timeout}ms"
                    )));
                }

                tokio::time::sleep(std::time::Duration::from_millis(DEFAULT_POLL_INTERVAL_MS))
                    .await;

                let resp = http
                    .get(&url)
                    .bearer_auth(&token)
                    .send()
                    .await
                    .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(e.to_string()))?;

                if !resp.status().is_success() {
                    let status = resp.status();
                    let body = resp.text().await.unwrap_or_default();
                    return Err(pyo3::exceptions::PyRuntimeError::new_err(classify_error(
                        &format!("{status}: {body}"),
                    )));
                }

                let raw: GenieMessageRaw = resp
                    .json()
                    .await
                    .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(e.to_string()))?;

                let state = raw.status.as_deref().unwrap_or("");
                if state == "COMPLETED" || state == "FAILED" {
                    return Ok(GenieMessage::from_raw(&raw));
                }
            }
        })
    }

    /// List messages in a conversation (paginated).
    #[pyo3(signature = (token, space_id, conversation_id, *, page_size = None, page_token = None))]
    fn list_messages<'py>(
        &self,
        py: Python<'py>,
        token: String,
        space_id: String,
        conversation_id: String,
        page_size: Option<u32>,
        page_token: Option<String>,
    ) -> PyResult<Bound<'py, PyAny>> {
        let http = self.http.clone();
        let host = self.host.clone();
        let timeout = self.timeout_ms;
        let max_msgs = self.max_messages;
        let ps = page_size.unwrap_or(DEFAULT_INITIAL_PAGE_SIZE);

        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let tmp = GenieConnector {
                host,
                timeout_ms: timeout,
                max_messages: max_msgs,
                http,
            };

            let (messages, next_token) = tmp
                .list_messages_internal(&token, &space_id, &conversation_id, ps, page_token.as_deref())
                .await
                .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(classify_error(&e)))?;

            Ok((messages, next_token))
        })
    }

    /// Get the query result for a message attachment.
    #[pyo3(signature = (token, space_id, conversation_id, message_id, attachment_id))]
    fn get_query_result<'py>(
        &self,
        py: Python<'py>,
        token: String,
        space_id: String,
        conversation_id: String,
        message_id: String,
        attachment_id: String,
    ) -> PyResult<Bound<'py, PyAny>> {
        let http = self.http.clone();
        let base = self.base_url(&space_id);

        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let url = format!(
                "{}/conversations/{}/messages/{}/attachments/{}/query-result",
                base, conversation_id, message_id, attachment_id,
            );

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
                    "Failed to fetch query result for attachment {attachment_id} ({status}): {body}"
                )));
            }

            let wrapper: QueryResultWrapper = resp
                .json()
                .await
                .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(e.to_string()))?;

            let data = wrapper
                .statement_response
                .map(|v| serde_json::to_string(&v).unwrap_or_else(|_| "null".into()))
                .unwrap_or_else(|| "null".into());

            Ok(GenieQueryResult { data })
        })
    }

    /// Fetch full conversation history (all pages up to max_messages).
    #[pyo3(signature = (token, space_id, conversation_id))]
    fn get_conversation<'py>(
        &self,
        py: Python<'py>,
        token: String,
        space_id: String,
        conversation_id: String,
    ) -> PyResult<Bound<'py, PyAny>> {
        let http = self.http.clone();
        let host = self.host.clone();
        let timeout = self.timeout_ms;
        let max_msgs = self.max_messages;

        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let tmp = GenieConnector {
                host,
                timeout_ms: timeout,
                max_messages: max_msgs,
                http,
            };

            let mut all_messages = Vec::new();
            let mut page_token: Option<String> = None;

            loop {
                let (messages, next) = tmp
                    .list_messages_internal(
                        &token,
                        &space_id,
                        &conversation_id,
                        DEFAULT_PAGE_SIZE,
                        page_token.as_deref(),
                    )
                    .await
                    .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(classify_error(&e)))?;

                all_messages.extend(messages);

                match next {
                    Some(tok) if all_messages.len() < max_msgs => page_token = Some(tok),
                    _ => break,
                }
            }

            all_messages.truncate(max_msgs);

            Ok(GenieConversationHistory {
                conversation_id,
                space_id,
                messages: all_messages,
            })
        })
    }

    fn __repr__(&self) -> String {
        format!(
            "GenieConnector(host={:?}, timeout_ms={}, max_messages={})",
            self.host, self.timeout_ms, self.max_messages
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_classify_error_resource_not_found() {
        let msg = classify_error("Something RESOURCE_DOES_NOT_EXIST happened");
        assert!(msg.contains("access to this Genie Space"));
    }

    #[test]
    fn test_classify_error_table_permissions() {
        let msg = classify_error("failed to reach COMPLETED state: FAILED");
        assert!(msg.contains("table permissions"));
    }

    #[test]
    fn test_classify_error_empty() {
        let msg = classify_error("");
        assert_eq!(msg, "Genie request failed");
    }

    #[test]
    fn test_classify_error_passthrough() {
        let msg = classify_error("Some other error");
        assert_eq!(msg, "Some other error");
    }

    #[test]
    fn test_message_from_raw() {
        let raw = GenieMessageRaw {
            message_id: Some("msg-1".into()),
            conversation_id: Some("conv-1".into()),
            space_id: Some("space-1".into()),
            status: Some("COMPLETED".into()),
            content: Some("Hello".into()),
            attachments: Some(vec![GenieAttachmentRaw {
                attachment_id: Some("att-1".into()),
                query: Some(GenieQueryRaw {
                    title: Some("My Query".into()),
                    description: None,
                    query: Some("SELECT 1".into()),
                    statement_id: Some("stmt-1".into()),
                }),
                text: None,
                suggested_questions: None,
            }]),
            error: None,
        };

        let msg = GenieMessage::from_raw(&raw);
        assert_eq!(msg.message_id, "msg-1");
        assert_eq!(msg.status, "COMPLETED");
        assert_eq!(msg.attachments.len(), 1);
        assert_eq!(msg.attachments[0].query_sql.as_deref(), Some("SELECT 1"));
        assert_eq!(
            msg.attachments[0].query_statement_id.as_deref(),
            Some("stmt-1")
        );
    }

    #[test]
    fn test_message_from_raw_defaults() {
        let raw = GenieMessageRaw {
            message_id: None,
            conversation_id: None,
            space_id: None,
            status: None,
            content: None,
            attachments: None,
            error: None,
        };

        let msg = GenieMessage::from_raw(&raw);
        assert_eq!(msg.message_id, "");
        assert_eq!(msg.status, "COMPLETED");
        assert!(msg.attachments.is_empty());
    }
}
