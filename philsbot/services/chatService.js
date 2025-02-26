import { v4 as uuidv4 } from 'uuid';

// Session timeout in milliseconds (30 minutes)
const SESSION_TIMEOUT = 30 * 60 * 1000;
// ID of the OpenAI assistant to use
const ASSISTANT_ID = 'asst_bwx7JzTMDI0T8Px1cgnzNh8a';

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
      console.log('Assistant retrieved');
    }
    return assistant;
  } catch (error) {
    console.error('Error retrieving Assistant:', error);
    throw error;
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
    isCleaningUp: false, // Flag to prevent race conditions during cleanup
  };
  // Store the session in the sessions map
  sessions.set(sessionId, session);
  return sessionId;
}

/**
 * Cleans up a chat session, deleting the associated OpenAI thread and emitting a clear_chat event.
 * @param {string} sessionId The ID of the session to clean up.
 * @param {boolean} notifyClient Whether to notify the client about the session cleanup.
 * @returns {Promise<boolean>} A promise that resolves to true if cleanup was successful.
 */
async function cleanupSession(sessionId, notifyClient = true) {
  const session = sessions.get(sessionId);
  if (!session) return true; // Session already deleted

  // Prevent race conditions by checking if cleanup is already in progress
  if (session.isCleaningUp) return false;
  
  session.isCleaningUp = true;

  try {
    if (session.timeoutId) {
      clearTimeout(session.timeoutId);
      session.timeoutId = null;
    }

    if (session.threadId) {
      try {
        // Delete the OpenAI thread associated with the session
        await openai.beta.threads.del(session.threadId);
        console.log(`Thread ${session.threadId} deleted for session ${sessionId}`);
      } catch (error) {
        console.error(`Error deleting thread for session ${sessionId}:`, error);
        // Continue with session deletion even if thread deletion fails
      }
    }

    // Notify client about session cleanup if requested
    if (notifyClient) {
      io.emit('clear_chat', { sessionId, reason: 'session_timeout' });
    }

    // Remove the session from the sessions map
    sessions.delete(sessionId);
    return true;
  } catch (error) {
    console.error(`Unexpected error during session cleanup for ${sessionId}:`, error);
    session.isCleaningUp = false;
    return false;
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
  session.timeoutId = setTimeout(() => cleanupSession(sessionId), SESSION_TIMEOUT);
}

/**
 * Validates a session ID and returns the session object if valid.
 * @param {string} sessionId The session ID to validate.
 * @param {object} socket The Socket.IO socket to emit errors to.
 * @returns {object|null} The session object or null if invalid.
 */
function validateSession(sessionId, socket) {
  if (!sessionId || !sessions.has(sessionId)) {
    socket.emit('error', { 
      message: 'Invalid session',
      code: 'SESSION_INVALID'
    });
    return null;
  }
  return sessions.get(sessionId);
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
  socket.on('init_session', async () => {
    console.log('New session created');
    // Create a new session and emit the session ID to the client
    sessionId = createSession();
    
    try {
      // Pre-retrieve the assistant to ensure it's available
      await retrieveAssistant();
      socket.emit('session_created', { sessionId });
    } catch (error) {
      socket.emit('error', { 
        message: 'Failed to initialize chat session',
        code: 'ASSISTANT_INIT_FAILED'
      });
    }
  });

  // Event handler for resuming an existing session
  socket.on('resume_session', async (data) => {
    if (data.sessionId && sessions.has(data.sessionId)) {
      // If the session exists, resume it
      sessionId = data.sessionId;
      const session = sessions.get(sessionId);
      
      // Check if the session is expired but hasn't been cleaned up yet
      const isExpired = Date.now() - session.lastActive > SESSION_TIMEOUT;
      
      if (isExpired) {
        // Clean up the expired session and create a new one
        await cleanupSession(sessionId);
        sessionId = createSession();
        socket.emit('session_created', { 
          sessionId,
          wasExpired: true
        });
      } else {
        refreshSession(session, sessionId);
        socket.emit('session_resumed', { sessionId });
      }
    } else {
      // If the session doesn't exist, create a new one
      sessionId = createSession();
      socket.emit('session_created', { sessionId });
    }
  });

  // New event handler for manually clearing chat history
  socket.on('clear_chat', async (data) => {
    if (!data.sessionId) {
      socket.emit('error', { message: 'Session ID required' });
      return;
    }
    
    if (sessions.has(data.sessionId)) {
      // Clean up the session and create a new one
      const success = await cleanupSession(data.sessionId, true);
      
      if (success) {
        sessionId = createSession();
        socket.emit('session_created', { 
          sessionId,
          wasCleared: true
        });
      } else {
        socket.emit('error', { 
          message: 'Failed to clear chat history. Please try again.',
          code: 'CLEAR_FAILED'
        });
      }
    } else {
      // If the session doesn't exist, create a new one
      sessionId = createSession();
      socket.emit('session_created', { sessionId });
    }
  });

  // Event handler for sending a prompt to the OpenAI assistant
  socket.on('send_prompt', async (data) => {
    const session = validateSession(sessionId, socket);
    if (!session) return;

    refreshSession(session, sessionId);

    // Variable to store the full response from the assistant
    let fullResponse = '';
    let runId = null;

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
        role: 'user',
        content: data.prompt,
      });

      // Stream the assistant's response
      const stream = openai.beta.threads.runs
        .stream(session.threadId, {
          assistant_id: assistant.id,
        });
      
      stream
        .on('created', (run) => {
          runId = run.id;
        })
        .on('textCreated', (text) => {
          // Emit textCreated events to the client
          socket.emit('textCreated', text);
        })
        .on('textDelta', (textDelta, snapshot) => {
          // Append the text delta to the full response and emit textDelta events
          fullResponse += textDelta.value;
          socket.emit('textDelta', { textDelta, snapshot });
        })
        .on('error', (error) => {
          console.error('Error in stream:', error);
          socket.emit('error', { 
            message: 'Error processing your request', 
            code: 'STREAM_ERROR' 
          });
          
          // Handle stream error by attempting to cancel the run
          if (runId && session.threadId) {
            openai.beta.threads.runs.cancel(session.threadId, runId)
              .catch(err => console.error('Error canceling run:', err));
          }
        })
        .on('end', async () => {
          // Emit responseComplete event to the client
          socket.emit('responseComplete');
          refreshSession(session, sessionId);
        });
    } catch (error) {
      // Handle errors during prompt processing
      console.error('Error processing prompt:', error);
      socket.emit('error', { 
        message: 'Error processing your request',
        details: error.message,
        code: 'PROMPT_ERROR'
      });
    }
  });

  // Event handler for socket disconnection
  socket.on('disconnect', () => {
    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId);
      if (session) {
        // Set a timeout for session cleanup when the socket disconnects
        // Using a shorter timeout for disconnected sessions
        if (session.timeoutId) {
          clearTimeout(session.timeoutId);
        }
        session.timeoutId = setTimeout(
          () => cleanupSession(sessionId), 
          SESSION_TIMEOUT
        );
      }
    }
  });
}

// Export the setupSocketHandlers function
export { setupSocketHandlers, cleanupSession, sessions };