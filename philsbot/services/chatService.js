import { v4 as uuidv4 } from 'uuid';

export class ChatService {
  constructor(openai, io) {
    this.openai = openai;
    this.io = io;
    this.sessions = new Map();
    this.assistant = null;
    this.SESSION_TIMEOUT = 30 * 60 * 1000;
    this.ASSISTANT_ID = 'asst_bwx7JzTMDI0T8Px1cgnzNh8a';
  }

  async retrieveAssistant() {
    try {
      if (!this.assistant) {
        this.assistant = await this.openai.beta.assistants.retrieve(this.ASSISTANT_ID);
        console.log('Assistant retrieved');
      }
    } catch (error) {
      console.error('Error retrieving Assistant:', error);
    }
  }

  createSession() {
    const sessionId = uuidv4();
    const session = {
      threadId: null,
      lastActive: Date.now(),
      timeoutId: null,
    };
    this.sessions.set(sessionId, session);
    return sessionId;
  }

  async cleanupSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session?.threadId) {
      try {
        await this.openai.beta.threads.del(session.threadId);
        console.log(`Thread ${session.threadId} deleted for session ${sessionId}`);
        this.io.emit('clear_chat', { sessionId });
      } catch (error) {
        console.error(`Error deleting thread for session ${sessionId}:`, error);
      }
    }
    this.sessions.delete(sessionId);
  }

  async generateSmartReply(message) {
    const completions = await this.openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      max_tokens: 150,
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content: `Generate a JSON object containing three (4 to 6 word) suggested questions (smart replies) based on the provided message.

Rules for the Smart Replies:
First Reply: Closely related to the subject and specific content of the provided message.
Second Reply: Related to the subject but explores a broader angle.
Third Reply: Independent of the original context about real estate, the realtor, or services.`,
        },
        {
          role: 'user',
          content: message,
        },
      ],
    });

    return completions.choices[0].message.content;
  }

  setupSocketHandlers(socket) {
    let sessionId = null;

    socket.on('init_session', () => {
      console.log('New session created');
      sessionId = this.createSession();
      socket.emit('session_created', { sessionId });
    });

    socket.on('resume_session', (data) => {
      if (data.sessionId && this.sessions.has(data.sessionId)) {
        sessionId = data.sessionId;
        const session = this.sessions.get(sessionId);
        this.refreshSession(session, sessionId);
      } else {
        sessionId = this.createSession();
        socket.emit('session_created', { sessionId });
      }
    });

    socket.on('send_prompt', async (data) => {
      if (!sessionId || !this.sessions.has(sessionId)) {
        socket.emit('error', { message: 'Invalid session' });
        return;
      }

      const session = this.sessions.get(sessionId);
      this.refreshSession(session, sessionId);

      let fullResponse = '';

      try {
        await this.retrieveAssistant();

        if (!session.threadId) {
          const thread = await this.openai.beta.threads.create();
          session.threadId = thread.id;
        }

        await this.openai.beta.threads.messages.create(session.threadId, {
          role: 'user',
          content: data.prompt,
        });

        this.openai.beta.threads.runs
          .stream(session.threadId, {
            assistant_id: this.assistant.id,
          })
          .on('textCreated', (text) => {
            socket.emit('textCreated', text);
          })
          .on('textDelta', (textDelta, snapshot) => {
            fullResponse += textDelta.value;
            socket.emit('textDelta', { textDelta, snapshot });
          })
          .on('toolCallCreated', (toolCall) => {
            socket.emit('toolCallCreated', toolCall);
          })
          .on('toolCallDelta', (toolCallDelta, snapshot) => {
            if (toolCallDelta.type === 'code_interpreter') {
              if (toolCallDelta.code_interpreter.input) {
                socket.emit('codeInterpreterInput', toolCallDelta.code_interpreter.input);
              }
              if (toolCallDelta.code_interpreter.outputs) {
                toolCallDelta.code_interpreter.outputs.forEach((output) => {
                  if (output.type === 'logs') {
                    socket.emit('codeInterpreterLogs', output.logs);
                  }
                });
              }
            }
          })
          .on('end', async () => {
            socket.emit('responseComplete');
            const quickReplyJSON = await this.generateSmartReply(fullResponse);
            socket.emit('quickReplies', quickReplyJSON);

            session.timeoutId = setTimeout(
              () => this.cleanupSession(sessionId),
              this.SESSION_TIMEOUT
            );
          });
      } catch (error) {
        console.error('Error processing prompt:', error);
        socket.emit('error', { message: 'Error processing your request' });
      }
    });

    socket.on('disconnect', () => {
      if (sessionId) {
        const session = this.sessions.get(sessionId);
        if (session) {
          session.timeoutId = setTimeout(
            () => this.cleanupSession(sessionId),
            this.SESSION_TIMEOUT
          );
        }
      }
    });
  }

  refreshSession(session, sessionId) {
    session.lastActive = Date.now();
    if (session.timeoutId) {
      clearTimeout(session.timeoutId);
    }
    session.timeoutId = setTimeout(
      () => this.cleanupSession(sessionId),
      this.SESSION_TIMEOUT
    );
  }
}