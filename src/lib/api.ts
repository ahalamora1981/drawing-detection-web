"use client";

import { withBasePath } from "./basePath";
import { requirePinAgain } from "./pinSignal";

/**
 * fetch() wrapper for the app's API.
 *
 * Adds the deployment base path and re-arms the PIN dialog when the server
 * answers 401 (expired cookie / server restart) instead of leaving the user
 * staring at a bare error message.
 */
export async function apiFetch(
  path: string,
  init?: RequestInit
): Promise<Response> {
  const res = await fetch(withBasePath(path), init);
  if (res.status === 401) requirePinAgain();
  return res;
}

/** Error carrying the server's stable `code` so the UI can localise it. */
export class ApiError extends Error {
  code?: string;

  constructor(code: string | undefined, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}

/** Read a failed response body into an ApiError (never throws). */
export async function readApiError(res: Response): Promise<ApiError> {
  let data: { code?: string; error?: string } = {};
  try {
    data = await res.json();
  } catch {
    // non-JSON body (e.g. a proxy error page)
  }
  return new ApiError(data.code, data.error ?? "");
}
