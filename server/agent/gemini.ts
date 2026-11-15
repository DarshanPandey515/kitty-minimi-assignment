import { GoogleGenAI, ThinkingLevel } from "@google/genai";

export const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY ?? "" });
export const MODEL_ROUTER = () => process.env.GEMINI_MODEL_ROUTER ?? "gemini-3.5-flash-lite";
export const MODEL_SYNTH = () => process.env.GEMINI_MODEL_SYNTH ?? "gemini-3.5-flash-lite";
export const MODEL_EXTRACT = () => process.env.GEMINI_MODEL_EXTRACT ?? "gemini-3.5-flash-lite";
export const thinkingConfig = { thinkingLevel: ThinkingLevel.LOW };

export function parseJson(raw: string): unknown {
  const clean = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  return JSON.parse(clean);
}
