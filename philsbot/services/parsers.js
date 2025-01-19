import { cleanText, parsePrice, parseDimensions } from './utils.js';

export const parseAddress = (addressString) => {
  const parts = addressString.split(' ');
  const postalCode = parts.find(part => /^[A-Z]\d[A-Z]\s?\d[A-Z]\d$/.test(part)) || '';
  const city = parts.find(part => ['Burnaby', 'Vancouver', 'Richmond'].includes(part)) || '';

  return {
    streetNumber: parts[0],
    streetName: parts[1],
    streetType: parts[2],
    city,
    postalCode,
    neighborhood: parts.slice(parts.indexOf(postalCode) + 1).join(' ') || ''
  };
};

export const extractDetailsFromSummary = (summaryText) => {
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
  const floorAreaMatch = summaryText.match(/Floor Area:\s*([\d,]+)\s*sq\.\s*ft\./);
  if (floorAreaMatch) {
    details.floorArea = {
      sqft: parseInt(floorAreaMatch[1].replace(/,/g, '')),
      sqm: parseInt(summaryText.match(/(\d+)\s*m2/)?.[1] || '0')
    };
  }
  return details;
};

export const extractListingInfo = ($, element) => {
  const imgElement = $(element).find('.mrp-listing-main-image-container img');
  const imageUrl = imgElement.attr('data-src') || imgElement.attr('src');
  const listingDetailsText = cleanText($(element).find('.mrp-listing-summary-outer').text());
  const details = extractDetailsFromSummary(listingDetailsText);

  return {
    listingId: $(element).attr('data-listing-id'),
    shareUrl: $(element).attr('data-share-url'),
    price: {
      amount: parsePrice($(element).find('.mrp-listing-price-container').text().trim()),
      formatted: $(element).find('.mrp-listing-price-container').text().trim()
    },
    status: $(element).find('.status-line span').text().trim(),
    location: parseAddress(cleanText($(element).find('.mrp-listing-address-info').text())),
    imageUrl: imageUrl ? imageUrl.trim() : null,
    details
  };
};

export const parseDetailedInfo = (detailedInfo) => {
  if (!detailedInfo) return null;

  return {
    description: extractDescription(detailedInfo),
    features: {
      yearBuilt: extractYearBuilt(detailedInfo),
      parking: extractParking(detailedInfo),
      heating: extractHeating(detailedInfo),
      amenities: extractAmenities(detailedInfo),
      construction: extractConstruction(detailedInfo)
    },
    rooms: extractRooms(detailedInfo),
    taxes: extractTaxes(detailedInfo),
    lotInfo: extractLotInfo(detailedInfo)
  };
};

const extractDescription = (text) => {
  const descEnd = text.indexOf('Documents & Links:');
  return text
    .substring(0, descEnd > 0 ? descEnd : text.indexOf('General Info:'))
    .trim();
};

const extractYearBuilt = (text) => {
  const match = text.match(/Year built:\s*(\d{4})/);
  return match ? parseInt(match[1]) : null;
};

const extractParking = (text) => {
  const match = text.match(/Parking:([^.]+)/);
  return match ? match[1].trim().split(',').map(p => p.trim()) : [];
};

const extractHeating = (text) => {
  const match = text.match(/Heating:([^.]+)/);
  return match ? match[1].trim().split(',').map(h => h.trim()) : [];
};

const extractAmenities = (text) => {
  const match = text.match(/Features Included:([^.]+)/);
  return match ? match[1].trim().split(',').map(a => a.trim()) : [];
};

const extractConstruction = (text) => {
  const match = text.match(/Construction:([^.]+)/);
  return match ? match[1].trim() : null;
};

const extractRooms = (text) => {
  const rooms = [];
  const roomSection = text.match(/Room Information:(.+?)(?=Bathrooms:)/s);
  
  if (roomSection) {
    const roomLines = roomSection[1].split('\n');
    for (const line of roomLines) {
      const roomMatch = line.match(/(\w+)\s+(\w+\s*\w*)\s+([\d'\"×]+)\s*×\s*([\d'\"]+)/);
      if (roomMatch) {
        rooms.push({
          floor: roomMatch[1],
          type: roomMatch[2],
          dimensions: parseDimensions(`${roomMatch[3]} × ${roomMatch[4]}`)
        });
      }
    }
  }
  return rooms;
};

const extractTaxes = (text) => {
  const match = text.match(/Taxes:\s*\$?([\d,]+\.?\d*)\s*\/\s*(\d{4})/);
  return match ? {
    amount: parseFloat(match[1].replace(/,/g, '')),
    year: parseInt(match[2])
  } : null;
};

const extractLotInfo = (text) => {
  const lotAreaMatch = text.match(/Lot Area:\s*([\d,]+)\s*sq\.\s*ft\./);
  return {
    area: lotAreaMatch ? {
      sqft: parseInt(lotAreaMatch[1].replace(/,/g, '')),
      sqm: parseInt(text.match(/(\d+\.?\d*)\s*m2/)?.[1] || '0')
    } : null
  };
};