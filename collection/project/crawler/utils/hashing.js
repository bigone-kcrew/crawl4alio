const crypto = require('crypto');

/**
 * Generate a unique ID for a disclosure record.
 * @param {string} instCode 
 * @param {string} itemCode 
 * @param {string} disclosureNo 
 */
function generateId(instCode, itemCode, disclosureNo) {
    const data = `${instCode}-${itemCode}-${disclosureNo}`;
    return crypto.createHash('md5').update(data).digest('hex');
}

module.exports = { generateId };
