// IMPORTS
import axios from "axios";
import * as cheerio from "cheerio";
import OpenAI from "openai";
import fs from "fs";
import cron from "node-cron";
import express from "express";
import cors from "cors";
import http from "http";
import { Server } from "socket.io"; 
import { v4 as uuidv4 } from "uuid";
import dotenv from 'dotenv';

dotenv.config();

// Create an Express app
const app = express();

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ["https://jackpangalia.github.io", "https://jackpangalia.github.io/Philswebsitebot", "http://127.0.0.1:5500"],
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
    credentials: true,
  },
});

// Apply global CORS settings for Express
app.use(cors({
  origin: ["https://jackpangalia.github.io", "https://jackpangalia.github.io/Philswebsitebot", "http://127.0.0.1:5500"],
  credentials: true,
}));

// Define the openai client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

//! ----- (BELOW) SOCKET.IO CODE RELATED TO GENERATING THE RESPONSE AND STREAMING THE RESPONE BACK TO THE FROTNEND ------- !//
// Null values of the threadId and assistant yet to be created (These varibles will be populated with the respected values)
let threadId = null;
let assistant = null;

//! Define assistant ID

//! Retrieve the assistant by ID //TODO: consider using parameter for "ID"

//! Function to create thread

//! Function for the smart reply system (smartReply)

// Add these after other const declarations
const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes in milliseconds
// const SESSION_TIMEOUT = 20 * 1000
const sessions = new Map();

// Add this function to manage sessions
const createSession = () => {
  const sessionId = uuidv4();
  const session = {
    threadId: null,
    lastActive: Date.now(),
    timeoutId: null,
  };
  sessions.set(sessionId, session);
  return sessionId;
};

// Add function to cleanup sessions
const cleanupSession = async (sessionId) => {
  const session = sessions.get(sessionId);
  if (session && session.threadId) {
    try {
      await openai.beta.threads.del(session.threadId);
      console.log(
        `Thread ${session.threadId} deleted for session ${sessionId}`
      );
      // Emit an event to clear messages for this session
      io.emit("clear_chat", { sessionId });
    } catch (error) {
      console.error(`Error deleting thread for session ${sessionId}:`, error);
    }
  }
  sessions.delete(sessionId);
};

// AI response genreation code
io.on("connection", (socket) => {
  let sessionId = null;

  socket.on("init_session", () => {
    sessionId = createSession();
    socket.emit("session_created", { sessionId });
  });

  socket.on("resume_session", (data) => {
    if (data.sessionId && sessions.has(data.sessionId)) {
      sessionId = data.sessionId;
      const session = sessions.get(sessionId);
      session.lastActive = Date.now();

      // Clear existing timeout if any
      if (session.timeoutId) {
        clearTimeout(session.timeoutId);
      }

      // Set new timeout
      session.timeoutId = setTimeout(() => {
        cleanupSession(sessionId);
      }, SESSION_TIMEOUT);
    } else {
      sessionId = createSession();
      socket.emit("session_created", { sessionId });
    }
  });

  socket.on("send_prompt", async (data) => {
    if (!sessionId || !sessions.has(sessionId)) {
      socket.emit("error", { message: "Invalid session" });
      return;
    }

    const session = sessions.get(sessionId);
    session.lastActive = Date.now();

    // Clear existing timeout if any
    if (session.timeoutId) {
      clearTimeout(session.timeoutId);
    }

    const prompt = data.prompt;
    let fullResponse = "";

    const generateResponse = async () => {
      await retrieveAssistant();

      // Use existing thread ID from session or create new one
      if (!session.threadId) {
        const thread = await openai.beta.threads.create();
        session.threadId = thread.id;
      }

      const message = await openai.beta.threads.messages.create(
        session.threadId,
        {
          role: "user",
          content: prompt,
        }
      );

      openai.beta.threads.runs
        .stream(session.threadId, {
          assistant_id: assistant.id,
        })
        .on("textCreated", (text) => {
          socket.emit("textCreated", text);
        })
        .on("textDelta", (textDelta, snapshot) => {
          fullResponse += textDelta.value; // Append each chunk to fullResponse
          socket.emit("textDelta", { textDelta, snapshot });
        })
        .on("toolCallCreated", (toolCall) => {
          socket.emit("toolCallCreated", toolCall);
        })
        .on("toolCallDelta", (toolCallDelta, snapshot) => {
          if (toolCallDelta.type === "code_interpreter") {
            if (toolCallDelta.code_interpreter.input) {
              socket.emit(
                "codeInterpreterInput",
                toolCallDelta.code_interpreter.input
              );
            }
            if (toolCallDelta.code_interpreter.outputs) {
              toolCallDelta.code_interpreter.outputs.forEach((output) => {
                if (output.type === "logs") {
                  socket.emit("codeInterpreterLogs", output.logs);
                }
              });
            }
          }
        })
        .on("end", async () => {
          socket.emit("responseComplete");
          const quickReplyJSON = await smartReply(fullResponse);
          socket.emit("quickReplies", quickReplyJSON);

          // Set new timeout after response is complete
          session.timeoutId = setTimeout(() => {
            cleanupSession(sessionId);
          }, SESSION_TIMEOUT);
        });
    };

    generateResponse();
  });

  socket.on("disconnect", async () => {
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (session) {
        // Don't delete immediately on disconnect, let the timeout handle it
        session.timeoutId = setTimeout(() => {
          cleanupSession(sessionId);
        }, SESSION_TIMEOUT);
      }
    }
  });
});

//! ----- (ABOVE) SOCKET.IO CODE RELATED TO GENERATING THE RESPONSE AND STREAMING THE RESPONE BACK TO THE FROTNEND ------- !//
// Start the server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});