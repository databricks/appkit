SELECT 
    id,
    message,
    response,
    timestamp
FROM your_catalog.your_schema.chat_messages
ORDER BY timestamp ASC

