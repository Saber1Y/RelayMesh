// Typed fetch helpers for the RelayMesh API. Amounts stay as decimal strings on the client.

export interface ApiError {
  code: string;
  message: string;
  field?: string;
}

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly error: ApiError,
  ) {
    super(error.message);
    this.name = "ApiRequestError";
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  } catch {
    throw new ApiRequestError(0, { code: "NETWORK", message: "Could not reach the RelayMesh server. Check your connection and retry." });
  }
  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : undefined;
  if (!response.ok) {
    const error = (body as { error?: ApiError } | undefined)?.error ?? { code: "HTTP_" + response.status, message: response.statusText };
    throw new ApiRequestError(response.status, error);
  }
  return body as T;
}

// Wire shapes (bigint fields serialized as strings).
export type Wire<T> = T extends bigint
  ? string
  : T extends readonly (infer U)[]
    ? Wire<U>[]
    : T extends object
      ? { [K in keyof T]: Wire<T[K]> }
      : T;
