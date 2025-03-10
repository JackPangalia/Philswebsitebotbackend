import { v4 as uuidv4 } from "uuid";

// Session timeout in milliseconds (30 minutes)
const SESSION_TIMEOUT = 30 * 60 * 1000;
// ID of the OpenAI assistant to use
const ASSISTANT_ID = "asst_CggkpXPBSFzUM6e2BjZMuOc8";

// Variables to hold OpenAI and Socket.IO instances
let openai;
let io;
// Map to store active chat sessions, keyed by session ID
const sessions = new Map();
// Variable to store the retrieved OpenAI assistant object
let assistant = null;

/**
 * Retrieves the OpenAI assistant object.
 */
async function retrieveAssistant() {
  try {
    if (!assistant) {
      // If the assistant hasn't been retrieved yet, fetch it from OpenAI
      assistant = await openai.beta.assistants.retrieve(ASSISTANT_ID);
      console.log("Assistant retrieved");
    }
  } catch (error) {
    console.error("Error retrieving Assistant:", error);
  }
}

/**
 * Creates a new chat session and returns its ID.
 * @returns {string} The ID of the new session.
 */
function createSession() {
  // Generate a unique session ID
  const sessionId = uuidv4();
  // Create a session object with initial values
  const session = {
    threadId: null, // OpenAI thread ID, initialized to null
    lastActive: Date.now(), // Timestamp of the last activity
    timeoutId: null, // Timeout ID for session cleanup
  };
  // Store the session in the sessions map
  sessions.set(sessionId, session);
  return sessionId;
}

/**
 * Cleans up a chat session, deleting the associated OpenAI thread and emitting a clear_chat event.
 * @param {string} sessionId The ID of the session to clean up.
 */
async function cleanupSession(sessionId) {
  const session = sessions.get(sessionId);
  if (session?.threadId) {
    try {
      // Delete the OpenAI thread associated with the session
      await openai.beta.threads.del(session.threadId);
      console.log(
        `Thread ${session.threadId} deleted for session ${sessionId}`
      );
      // Emit a clear_chat event to the client
      io.emit("clear_chat", { sessionId });
    } catch (error) {
      console.error(`Error deleting thread for session ${sessionId}:`, error);
    }
  }
  // Remove the session from the sessions map
  sessions.delete(sessionId);
}

/**
 * Generates smart reply suggestions.
 * @param {string} response The response of which to generate replys to.
 * @param {string} propmt The users prompt sent to create the AI response.
 * @returns {array} suggestionsArray. Array with the AI generated suggestions.
 */
async function generateSuggestions(prompt, response) {
  console.log("generating suggestions");
  try {
    const aiChatbotResponsePrompt = response;
    const systemIntructionPrompt = `You are a helpful assistant designed to generate three short, relevant, and natural-sounding quick reply suggestions for a user interacting with an AI chatbot.

**Input:** The preceding AI chatbot response.

**Task:** Analyze the AI chatbot's response and generate three distinct, concise, and user-friendly quick reply suggestions. These suggestions should:

* **Be short and easy to understand.** Aim for 2-10 words, or short phrases.
* **Be relevant to the AI's response.** The suggestions should logically follow the conversation.
* **Offer different directions for the conversation.** Avoid repetitive suggestions.
* **Be phrased as potential user prompts.** They should sound like something a user would naturally say. Frame the quick replies as if the user is directly speaking to the chatbot.
* **Be suitable for a casual, conversational tone.**
* **Focus on furthering the conversation or asking for clarification.**

**Output JSON Format:**

{
  "quick_replies": [
    "Quick Reply 1",
    "Quick Reply 2",
    "Quick Reply 3"
  ]
}

**Example:**

**Input:** "The weather in London is currently cloudy with a chance of rain."

**Output:**

{
  "quick_replies": [
    "Tell me more",
    "What is the temperature",
    "Show me pictures."
  ]
}`;

    const suggestionResponse = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      max_tokens: 150,
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content: systemIntructionPrompt,
        },
        {
          role: "user",
          content: aiChatbotResponsePrompt,
        },
      ],
      
    });

    const suggestionsString = suggestionResponse.choices[0].message.content;
    const suggestionsJson = JSON.parse(suggestionsString);
    const suggestionsArray = suggestionsJson.quick_replies;
    return suggestionsArray;
  } catch (error) {
    console.error("error generating suggestions:", error);
    return [];
  }
}
/**
 * Refreshes the last activity timestamp of a session and resets its timeout.
 * @param {object} session The session object.
 * @param {string} sessionId The ID of the session.
 */
function refreshSession(session, sessionId) {
  // Update the last activity timestamp
  session.lastActive = Date.now();
  // Clear any existing timeout
  if (session.timeoutId) {
    clearTimeout(session.timeoutId);
  }
  // Set a new timeout for session cleanup
  session.timeoutId = setTimeout(
    () => cleanupSession(sessionId),
    SESSION_TIMEOUT
  );
}

/**
 * Sets up Socket.IO event handlers for chat interactions.
 * @param {Socket} socket The Socket.IO socket object.
 * @param {OpenAI} openAiInstance The OpenAI client instance.
 * @param {Server} ioInstance The Socket.IO server instance.
 */
function setupSocketHandlers(socket, openAiInstance, ioInstance) {
  // Store OpenAI and Socket.IO instances
  openai = openAiInstance;
  io = ioInstance;
  // Variable to store the current session ID for the socket
  let sessionId = null;

  // Event handler for initializing a new session
  socket.on("init_session", () => {
    console.log("New session created");
    // Create a new session and emit the session ID to the client
    sessionId = createSession();
    socket.emit("session_created", { sessionId });
  });

  // Event handler for resuming an existing session
  socket.on("resume_session", (data) => {
    if (data.sessionId && sessions.has(data.sessionId)) {
      // If the session exists, resume it
      sessionId = data.sessionId;
      const session = sessions.get(sessionId);
      refreshSession(session, sessionId);
    } else {
      // If the session doesn't exist, create a new one
      sessionId = createSession();
      socket.emit("session_created", { sessionId });
    }
  });

  // Event handler for sending a prompt to the OpenAI assistant
  socket.on("send_prompt", async (data) => {
    if (!sessionId || !sessions.has(sessionId)) {
      // If the session is invalid, emit an error
      socket.emit("error", { message: "Invalid session" });
      return;
    }

    const session = sessions.get(sessionId);
    refreshSession(session, sessionId);

    // Variable to store the full response from the assistant
    let fullResponse = "";

    try {
      // Retrieve the OpenAI assistant
      await retrieveAssistant();

      if (!session.threadId) {
        // If the session doesn't have a thread ID, create a new thread
        const thread = await openai.beta.threads.create();
        session.threadId = thread.id;
      }

      // Create a new message in the OpenAI thread
      await openai.beta.threads.messages.create(session.threadId, {
        role: "user",
        content: data.prompt,
      });

      // Stream the assistant's response
      openai.beta.threads.runs
        .stream(session.threadId, {
          assistant_id: assistant.id,
        })
        .on("textCreated", (text) => {
          // Emit textCreated events to the client
          socket.emit("textCreated", text);
        })
        .on("textDelta", (textDelta, snapshot) => {
          // Append the text delta to the full response and emit textDelta events
          fullResponse += textDelta.value;
          socket.emit("textDelta", { textDelta, snapshot });
        })
        .on("end", async () => {
          // Emit responseComplete event to the client
          socket.emit("responseComplete");
          // Set a timeout for session cleanup
          try {
            const suggestions = await generateSuggestions(
              data.prompt,
              fullResponse
            ); // Call your suggestion generation function
            console.log("suggestions:", suggestions);
            socket.emit("suggestions", { suggestions });
          } catch (suggestionError) {
            console.error("Error generating suggestions:", suggestionError);
          }
          session.timeoutId = setTimeout(
            () => cleanupSession(sessionId),
            SESSION_TIMEOUT
          );
        });
    } catch (error) {
      // Handle errors during prompt processing
      console.error("Error processing prompt:", error);
      socket.emit("error", { message: "Error processing your request" });
    }
  });

  // Event handler for socket disconnection
  socket.on("disconnect", () => {
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (session) {
        // Set a timeout for session cleanup when the socket disconnects
        session.timeoutId = setTimeout(
          () => cleanupSession(sessionId),
          SESSION_TIMEOUT
        );
      }
    }
  });
}

// Export the setupSocketHandlers function
export { setupSocketHandlers };
