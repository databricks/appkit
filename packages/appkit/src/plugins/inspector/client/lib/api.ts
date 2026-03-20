/// <reference lib="dom" />

export function createApi(sessionHeader: string, sessionId: string) {
  const requestJson = async (path: string, payload: unknown): Promise<any> => {
    const response = await fetch(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [sessionHeader]: sessionId,
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error("Request failed with status " + response.status);
    }
    return response.json();
  };

  const fetchJson = async (path: string): Promise<any> => {
    const response = await fetch(path, {
      headers: { [sessionHeader]: sessionId },
    });
    if (!response.ok) {
      throw new Error("Request failed with status " + response.status);
    }
    return response.json();
  };

  return { requestJson, fetchJson };
}

export type InspectorApi = ReturnType<typeof createApi>;
