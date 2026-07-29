import { GoogleGenAI } from "@google/genai";
import config from "./config.js";
import logger from "./logger.js";

let aiClient: GoogleGenAI | null = null;

export function getAiClient(): GoogleGenAI | null {
  if (!aiClient) {
    const key = config.geminiApiKey;
    if (key && key !== "MY_GEMINI_API_KEY") {
      aiClient = new GoogleGenAI({
        apiKey: key,
        httpOptions: {
          headers: { "User-Agent": "aistudio-build" },
        },
      });
      logger.info("Gemini AI client initialized");
    }
  }
  return aiClient;
}

export function getAiModel(): string {
  return config.geminiModel;
}
