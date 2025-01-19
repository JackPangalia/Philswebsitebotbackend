// Clean up text by removing extra whitespace
export const cleanText = (text) => text.replace(/\s+/g, ' ').trim();

// Convert price string to number
export const parsePrice = (priceStr) => {
  return parseFloat(priceStr.replace(/[$,]/g, '')) || 0;
};

// Parse dimensions string (e.g., "20'6\" × 15'2\"")
export const parseDimensions = (dimStr) => {
  const parts = dimStr.split('×').map(d => d.trim());
  return {
    length: parts[0] || '',
    width: parts[1] || ''
  };
};

// Format date to YYYY-MM-DD
export const formatDate = (date) => {
  return new Date(date).toISOString().split('T')[0];
};