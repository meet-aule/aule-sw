import type { TeachingResource } from "./teaching-resources.js";

export function linkedPractice(page: Window): (language?: string) => TeachingResource | null;

/** The server validates the same published question as the browser. */
export function matchesPractice(
  id: unknown,
  language: string,
  objective?: { kind: string; subject: string; due: string | null; topic: string },
): boolean;
