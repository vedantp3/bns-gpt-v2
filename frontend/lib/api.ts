export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "") || "http://localhost:7860";

type FetchOptions = RequestInit & {
  noThrow?: boolean;
};

export async function apiFetch<T>(path: string, options: FetchOptions = {}): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  if (!response.ok && !options.noThrow) {
    const payload = await safeJson(response);
    throw new Error(payload?.detail || "Request failed.");
  }

  return safeJson(response) as Promise<T>;
}

/**
 * POST to an endpoint that answers with newline-delimited JSON and call onEvent
 * for each event as soon as its line arrives.
 */
export async function apiStream<E>(
  path: string,
  body: unknown,
  onEvent: (event: E) => void,
  signal?: AbortSignal
): Promise<void> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal
  });

  if (!response.ok || !response.body) {
    const payload = await safeJson(response);
    throw new Error(payload?.detail || "Request failed.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";

  for (;;) {
    const { done, value } = await reader.read();
    buffered += decoder.decode(value, { stream: !done });

    let newline = buffered.indexOf("\n");
    while (newline !== -1) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line) onEvent(JSON.parse(line) as E);
      newline = buffered.indexOf("\n");
    }

    if (done) break;
  }

  if (buffered.trim()) onEvent(JSON.parse(buffered) as E);
}

async function safeJson(response: Response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
