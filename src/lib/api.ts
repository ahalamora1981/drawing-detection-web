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
