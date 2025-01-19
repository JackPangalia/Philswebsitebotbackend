import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs";
import { cleanText } from "./utils.js";
import {
  extractListingInfo,
  parseDetailedInfo,
  extractDetailsFromSummary,
  parseAddress,

} from "./parsers.js";
import path from "path";

export class ScraperService {
  constructor(openai) {
    this.openai = openai;
  }

  async axiosWithRetry(url, retries = 3, delay = 1000, timeout = 10000) {
    for (let i = 0; i < retries; i++) {
      try {
        return await axios.get(url, {
          timeout,
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
  }
  
  async getLinksFromPage(url) {
    try {
      const { data } = await axios.get(url);
      const $ = cheerio.load(data);

      const listings = $("li.mrp-listing-result")
        .map((i, element) => extractListingInfo($, element))
        .get();

      if (listings.length === 0) {
        return { listings: [], foundInactive: true };
      }

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

  async scrapeListingDetails(shareUrl) {
    try {
      const { data } = await this.axiosWithRetry(shareUrl);
      const $ = cheerio.load(data);
      const rawDetailedInfo = cleanText(
        $(".mrp-listing-info-container").text()
      );
      return parseDetailedInfo(rawDetailedInfo);
    } catch (error) {
      console.error(
        `Error fetching the listing details from ${shareUrl}:`,
        error.message
      );
      return null;
    }
  }

  async scrapeAllListingsWithDetails(baseUrl, maxPages = 20) {
    let allListings = [];
    let currentPage = 1;
    let foundInactive = false;

    while (!foundInactive && currentPage <= maxPages) {
      const pageUrl = `${baseUrl}?_pg=${currentPage}`;
      console.log(`Scraping page ${currentPage}: ${pageUrl}`);

      try {
        const { listings, foundInactive: pageHasInactive } =
          await this.getLinksFromPage(pageUrl);

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

        await new Promise((resolve) => setTimeout(resolve, 1500));
        currentPage++;
      } catch (error) {
        console.error(`Error scraping page ${currentPage}:`, error);
        break;
      }
    }

    console.log(`Total listings found: ${allListings.length}`);

    const detailedListings = await Promise.all(
      allListings.map(async (listing) => {
        try {
          const detailedInfo = await this.scrapeListingDetails(
            listing.shareUrl
          );
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

  saveScrapedDataToFile(data, fileName) {
    fs.writeFileSync(fileName, JSON.stringify(data, null, 2));
    console.log(`Data saved to ${fileName}`);
  }

  async uploadFileToOpenAI(fileName) {
    console.log("file name: ", fileName);
    try {
      const file = await this.openai.files.create({
        file: fs.createReadStream(fileName),
        purpose: "assistants",
      });

      const myVectorStoreFile =
        await this.openai.beta.vectorStores.files.create(
          "vs_AhOMGRbrpoH3HhhlQq5Dv7oM",
          {
            file_id: file.id,
          }
        );
      console.log(myVectorStoreFile);
    } catch (error) {
      console.error("Error uploading file to OpenAI:", error);
    }
  }

  async scrapeAndUpdate() {
    try {
      const baseUrl = "https://dorisgee.com/mylistings.html";
      const listings = await this.scrapeAllListingsWithDetails(baseUrl);

      const fileName = `listings${new Date().toISOString().split("T")[0]}.json`;
      this.saveScrapedDataToFile(listings, fileName);

      await this.uploadFileToOpenAI(fileName);

      console.log("Scraping and uploading completed.");
    } catch (error) {
      console.error("An error occurred during scraping and updating:", error);
    }
  }
}
