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
    origin: "https://jackpangalia.github.io/Philswebsitebot",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
    credentials: true,
  },
});

app.use(cors());

// Define the openai client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

//! ----- (BELOW) CODE RELEATED TO SCRAPING LISTINGS FROM PHIL MOORES WEBSITE ------- !//
// Helper function to clean up text
const cleanText = (text) => text.replace(/\s+/g, " ").trim();

// Enhanced axios request function with retry logic
const axiosWithRetry = async (
  url,
  retries = 3,
  delay = 1000,
  timeout = 10000
) => {
  for (let i = 0; i < retries; i++) {
    try {
      return await axios.get(url, {
        timeout: timeout,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        },
      });
    } catch (err) {
      if (i === retries - 1) throw err;
      console.log(`Attempt ${i + 1} failed. Retrying in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
};

// Function to extract listing information from a page, including the image URL
const extractListingInfo = ($, element) => {
  const imgElement = $(element).find(".mrp-listing-main-image-container img");
  const imageUrl = imgElement.attr("data-src") || imgElement.attr("src");

  // Extract basic listing details and parse them
  const listingDetailsText = cleanText(
    $(element).find(".mrp-listing-summary-outer").text()
  );
  const details = extractDetailsFromSummary(listingDetailsText);

  return {
    listingId: $(element).attr("data-listing-id"),
    shareUrl: $(element).attr("data-share-url"),
    price: {
      amount: parseFloat(
        $(element)
          .find(".mrp-listing-price-container")
          .text()
          .trim()
          .replace(/[$,]/g, "")
      ),
      formatted: $(element).find(".mrp-listing-price-container").text().trim(),
    },
    status: $(element).find(".status-line span").text().trim(),
    location: parseAddress(
      cleanText($(element).find(".mrp-listing-address-info").text())
    ),
    imageUrl: imageUrl ? imageUrl.trim() : null,
    details: details,
  };
};

// Helper function to parse address into components
const parseAddress = (addressString) => {
  const parts = addressString.split(" ");
  const postalCode =
    parts.find((part) => /^[A-Z]\d[A-Z]\s?\d[A-Z]\d$/.test(part)) || "";

  return {
    streetNumber: parts[0],
    streetName: parts[1],
    streetType: parts[2],
    city:
      parts.find(
        (part) =>
          part === "Burnaby" || part === "Vancouver" || part === "Richmond"
      ) || "",
    postalCode: postalCode,
    neighborhood: parts.slice(parts.indexOf(postalCode) + 1).join(" ") || "",
  };
};

// Helper function to extract and structure details from summary
const extractDetailsFromSummary = (summaryText) => {
  const details = {};

  // Extract MLS number
  const mlsMatch = summaryText.match(/MLS®\s*Num:\s*([A-Z0-9]+)/);
  if (mlsMatch) details.mlsNumber = mlsMatch[1];

  // Extract bedrooms
  const bedroomsMatch = summaryText.match(/Bedrooms:\s*(\d+)/);
  if (bedroomsMatch) details.bedrooms = parseInt(bedroomsMatch[1]);

  // Extract bathrooms
  const bathroomsMatch = summaryText.match(/Bathrooms:\s*(\d+)/);
  if (bathroomsMatch) details.bathrooms = parseInt(bathroomsMatch[1]);

  // Extract floor area
  const floorAreaMatch = summaryText.match(
    /Floor Area:\s*([\d,]+)\s*sq\.\s*ft\./
  );
  if (floorAreaMatch) {
    details.floorArea = {
      sqft: parseInt(floorAreaMatch[1].replace(/,/g, "")),
      sqm: parseInt(summaryText.match(/(\d+)\s*m2/)?.[1] || "0"),
    };
  }

  return details;
};

// Enhanced function to parse detailed listing information
const parseDetailedInfo = (detailedInfo) => {
  if (!detailedInfo) return null;

  return {
    description: extractDescription(detailedInfo),
    features: {
      yearBuilt: extractYearBuilt(detailedInfo),
      parking: extractParking(detailedInfo),
      heating: extractHeating(detailedInfo),
      amenities: extractAmenities(detailedInfo),
      construction: extractConstruction(detailedInfo),
    },
    rooms: extractRooms(detailedInfo),
    taxes: extractTaxes(detailedInfo),
    lotInfo: extractLotInfo(detailedInfo),
  };
};

// Helper functions for parsing detailed info
const extractDescription = (text) => {
  const descEnd = text.indexOf("Documents & Links:");
  return text 
    .substring(0, descEnd > 0 ? descEnd : text.indexOf("General Info:"))
    .trim();
};

const extractYearBuilt = (text) => {
  const match = text.match(/Year built:\s*(\d{4})/);
  return match ? parseInt(match[1]) : null;
};

const extractParking = (text) => {
  const match = text.match(/Parking:([^.]+)/);
  return match
    ? match[1]
        .trim()
        .split(",")
        .map((p) => p.trim())
    : [];
};

const extractHeating = (text) => {
  const match = text.match(/Heating:([^.]+)/);
  return match
    ? match[1]
        .trim()
        .split(",")
        .map((h) => h.trim())
    : [];
};

const extractConstruction = (text) => {
  const match = text.match(/Construction:([^.]+)/);
  return match ? match[1].trim() : null;
};

const extractRooms = (text) => {
  const rooms = [];
  const roomSection = text.match(/Room Information:(.+?)(?=Bathrooms:)/s);
  if (roomSection) {
    const roomLines = roomSection[1].split("\n");
    for (const line of roomLines) {
      const roomMatch = line.match(
        /(\w+)\s+(\w+\s*\w*)\s+([\d'\"×]+)\s*×\s*([\d'\"]+)/
      );
      if (roomMatch) {
        rooms.push({
          floor: roomMatch[1],
          type: roomMatch[2],
          dimensions: {
            length: roomMatch[3],
            width: roomMatch[4],
          },
        });
      }
    }
  }
  return rooms;
};

const extractTaxes = (text) => {
  const match = text.match(/Taxes:\s*\$?([\d,]+\.?\d*)\s*\/\s*(\d{4})/);
  return match
    ? {
        amount: parseFloat(match[1].replace(/,/g, "")),
        year: parseInt(match[2]),
      }
    : null;
};

const extractLotInfo = (text) => {
  const lotAreaMatch = text.match(/Lot Area:\s*([\d,]+)\s*sq\.\s*ft\./);
  return {
    area: lotAreaMatch
      ? {
          sqft: parseInt(lotAreaMatch[1].replace(/,/g, "")),
          sqm: parseInt(text.match(/(\d+\.?\d*)\s*m2/)?.[1] || "0"),
        }
      : null,
  };
};

// Function to get listings from a page and check if we found any inactive listings
async function getLinksFromPage(url) {
  try {
    const { data } = await axios.get(url);
    const $ = cheerio.load(data);

    // Get all listings on the page
    const listings = $("li.mrp-listing-result")
      .map((i, element) => extractListingInfo($, element))
      .get();

    // Check if we found any listings at all
    if (listings.length === 0) {
      return { listings: [], foundInactive: true }; // No more listings means we're done
    }

    // Check if any listings are inactive
    const foundInactive = listings.some(
      (listing) =>
        listing.status.toLowerCase().includes("not active") ||
        listing.status.toLowerCase().includes("inactive") ||
        listing.status.toLowerCase().includes("sold") ||
        listing.status.toLowerCase().includes("pending")
    );

    return { listings, foundInactive };
  } catch (error) {
    console.error("Error fetching the page:", error);
    return { listings: [], foundInactive: false };
  }
}

// Update the scrapeListingDetails function to use the new parser
async function scrapeListingDetails(shareUrl) {
  try {
    const { data } = await axiosWithRetry(shareUrl);
    const $ = cheerio.load(data);
    const rawDetailedInfo = cleanText($(".mrp-listing-info-container").text());
    return parseDetailedInfo(rawDetailedInfo);
  } catch (error) {
    console.error(
      `Error fetching the listing details from ${shareUrl}:`,
      error.message
    );
    return null;
  }
}

// Enhanced function to scrape all listings with details until finding inactive ones
async function scrapeAllListingsWithDetails(baseUrl, maxPages = 20) {
  let allListings = [];
  let currentPage = 1;
  let foundInactive = false;

  while (!foundInactive && currentPage <= maxPages) {
    const pageUrl = `${baseUrl}?_pg=${currentPage}`;
    console.log(`Scraping page ${currentPage}: ${pageUrl}`);

    try {
      const { listings, foundInactive: pageHasInactive } =
        await getLinksFromPage(pageUrl);

      if (listings.length === 0) {
        console.log(
          `No listings found on page ${currentPage}. Stopping scrape.`
        );
        break;
      }

      allListings = allListings.concat(listings);
      foundInactive = pageHasInactive;

      if (foundInactive) {
        console.log(
          `Found inactive listing(s) on page ${currentPage}. Stopping scrape.`
        );
      } else {
        console.log(
          `Completed scraping page ${currentPage}. Found ${listings.length} listings.`
        );
      }

      // Add a small delay between pages to be polite to the server
      await new Promise((resolve) => setTimeout(resolve, 1500));
      currentPage++;
    } catch (error) {
      console.error(`Error scraping page ${currentPage}:`, error);
      break;
    }
  }

  console.log(`Total listings found: ${allListings.length}`);

  // Get detailed information for all listings
  const detailedListings = await Promise.all(
    allListings.map(async (listing) => {
      try {
        const detailedInfo = await scrapeListingDetails(listing.shareUrl);
        return { ...listing, detailedInfo };
      } catch (error) {
        console.error(
          `Failed to fetch details for ${listing.shareUrl}:`,
          error.message
        );
        return { ...listing, detailedInfo: null };
      }
    })
  );

  return detailedListings.filter((listing) => listing.detailedInfo !== null);
}

// Function to save scraped data to a file
const saveScrapedDataToFile = (data, fileName) => {
  fs.writeFileSync(fileName, JSON.stringify(data, null, 2));
  console.log(`Data saved to ${fileName}`);
};

// Function to upload the file to OpenAI vector store
const uploadFileToOpenAI = async (fileName) => {
  try {
    const file = await openai.files.create({
      file: fs.createReadStream(fileName),
      purpose: "assistants",
    });

    const myVectorStoreFile = await openai.beta.vectorStores.files.create(
      "vs_wjbc6c0aO6Rf6krRnQjWMjGF",
      {
        file_id: file.id,
      }
    );
    console.log(myVectorStoreFile);
  } catch (error) {
    console.error("Error uploading the file to OpenAI:", error);
  }
};

// Main function to scrape and update the vector store daily
const scrapeAndUpdate = async () => {
  try {
    const baseUrl = "https://dorisgee.com/mylistings.html";
    const listings = await scrapeAllListingsWithDetails(baseUrl);

    // Save the scraped data to a file
    const fileName = `listings${new Date().toISOString().split("T")[0]}.json`;
    saveScrapedDataToFile(listings, fileName);

    // Upload the file to OpenAI vector store
    await uploadFileToOpenAI(fileName);

    console.log("Scraping and uploading completed.");
  } catch (error) {
    console.error("An error occurred during scraping and updating:", error);
  }
};

// Schedule the scrapeAndUpdate function to run every 24 hours
cron.schedule('0 0 * * *', async () => {
  console.log('Running daily scrape and update task');
  await scrapeAndUpdate();
});

//! ----- (BELOW) SOCKET.IO CODE RELATED TO GENERATING THE RESPONSE AND STREAMING THE RESPONE BACK TO THE FROTNEND ------- !//
// Null values of the threadId and assistant yet to be created (These varibles will be populated with the respected values)
let threadId = null;
let assistant = null;

// Define assistant ID
const assistantId = "asst_bwx7JzTMDI0T8Px1cgnzNh8a";

// Retrieve the assistant by ID //TODO: consider using parameter for "ID"
const retrieveAssistant = async () => {
  try {
    if (!assistant) {
      assistant = await openai.beta.assistants.retrieve(assistantId);
      console.log("Assistant retrieved");
    }
  } catch (error) {
    console.error("There was an error retrieving Assistant ", error);
  }
};

// Function to create thread
const initializeThread = async () => {
  try {
    if (!threadId) {
      const thread = await openai.beta.threads.create();
      threadId = thread.id;
      console.log("Thread created");
    }
  } catch (error) {
    console.error("Error creating thread ", error);
  }
};

const smartReply = async (message) => {
  const completions = await openai.chat.completions.create({
    model: "gpt-3.5-turbo",
    max_tokens: 150,
    temperature: 0.1,
    messages: [
      {
        role: "system",
        content: `Generate a JSON object containing three (4 to 6 word) suggested questions (smart replies) based on the provided message.

Rules for the Smart Replies:

First Reply: Closely related to the subject and specific content of the provided message. It should directly engage with or continue the conversation context.
Second Reply: Related to the subject of the message but explores a broader or slightly different angle of the topic.
Third Reply: Completely independent of the original context. It should be a general or exploratory question about real estate, the realtor, or services offered.
Input Example
Message:
"Hello! 😊 I'm your assistant for Phil Moore and Doris Gee, here to help you with any real estate questions, buying or selling properties, and property searches in Burnaby, Vancouver, Richmond, and Coquitlam. How can I assist you today?"

Desired Output
{
  "smart_replies": [
    "Can you show me houses available in Burnaby?",
    "What are the best neighborhoods for families in Burnaby?",
    "What services does Phil Moore offer?"
  ]
}`,
      },
      {
        role: "user",
        content: `${message}`,
      },
    ],
  });

  return completions.choices[0].message.content;
};


// Add these after other const declarations
// const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes in milliseconds
const SESSION_TIMEOUT = 20 * 1000
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
