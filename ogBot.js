import axios from "axios";
import * as cheerio from "cheerio";
import OpenAI from "openai";
import fs from "fs";
import cron from "node-cron";

// Define the openai client
const openai = new OpenAI({
  apiKey:
    "",
});

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

const extractAmenities = (text) => {
  const match = text.match(/Features Included:([^.]+)/);
  return match
    ? match[1]
        .trim()
        .split(",")
        .map((a) => a.trim())
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

// Main function to run the scraper
async function main() {
  try {
    await scrapeAndUpdate();
  } catch (error) {
    console.error("An error occurred during scraping:", error);
  }
}

main();