import express from 'express';
import twilio from 'twilio';
import Message from '../models/Message.js';
import { v4 as uuidv4 } from 'uuid';
import { logInfo, logError } from '../utils/logger.js';

const router = express.Router();

// Initialize Twilio client with error handling
let twilioClient;
try {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    throw new Error('Missing required Twilio environment variables: TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN');
  }
  twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
} catch (error) {
  logError('Failed to initialize Twilio client:', error);
  process.exit(1); // Exit if Twilio cannot be initialized
}

/**
 * Helper function for retry logic with exponential backoff
 * Implements exponential backoff strategy for failed Twilio API calls
 * 
 * @param {Object} messageOptions - Twilio message options
 * @param {number} retryCount - Current retry attempt (0-based)
 * @param {number} maxRetries - Maximum number of retry attempts
 * @returns {Promise<Object>} - Result object with success flag and data/error
 */
const sendWithRetry = async (messageOptions, retryCount = 0, maxRetries = 3) => {
  try {
    logInfo(`Attempting to send message (attempt ${retryCount + 1}/${maxRetries + 1})`);
    const message = await twilioClient.messages.create(messageOptions);
    logInfo(`Message sent successfully on attempt ${retryCount + 1}: ${message.sid}`);
    return { success: true, message };
  } catch (error) {
    logError(`Send attempt ${retryCount + 1} failed:`, error);
    
    // Check if error is retryable (network issues, rate limits, temporary server errors)
    const retryableErrors = [20429, 20003, 20005, 21614]; // Rate limit, connection, timeout, queue full
    const isRetryable = retryableErrors.includes(error.code) || error.status >= 500;
    
    if (retryCount < maxRetries && isRetryable) {
      const delay = Math.pow(2, retryCount) * 1000; // 1s, 2s, 4s delays
      logInfo(`Retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return sendWithRetry(messageOptions, retryCount + 1, maxRetries);
    }
    
    return { success: false, error };
  }
};

/**
 * Validate and format phone numbers for WhatsApp
 * Ensures proper WhatsApp formatting and validates number format
 * Updated to handle international prefixes properly
 * 
 * @param {string} number - Phone number to format
 * @returns {string|null} - Formatted WhatsApp number or null if invalid
 */
const formatPhoneNumber = (number) => {
  if (!number || typeof number !== 'string') {
    return null;
  }
  
  // Remove any whitespace
  let cleanNumber = number.trim();
  
  // Return as-is if already in WhatsApp format
  if (cleanNumber.startsWith('whatsapp:')) {
    return cleanNumber;
  }
  
  // Handle the format we receive from frontend: whatsapp:+1234567890
  if (cleanNumber.startsWith('whatsapp:+')) {
    cleanNumber = cleanNumber.substring(9); // Remove 'whatsapp:' prefix
  }
  
  // If it starts with 'whatsapp:' but not '+', handle appropriately
  if (cleanNumber.startsWith('whatsapp:')) {
    cleanNumber = cleanNumber.substring(9); // Remove 'whatsapp:' prefix
    // Add '+' if not present
    if (!cleanNumber.startsWith('+')) {
      cleanNumber = '+' + cleanNumber;
    }
  }
  
  // Remove all non-digit characters except +
  cleanNumber = cleanNumber.replace(/[^\d+]/g, '');
  
  // If it doesn't start with '+', we need to handle it
  if (!cleanNumber.startsWith('+')) {
    // Remove all non-digit characters
    const digitsOnly = cleanNumber.replace(/\D/g, '');
    
    // Handle UAE numbers specifically
    if (digitsOnly.startsWith('971')) {
      // Already has UAE country code
      cleanNumber = '+' + digitsOnly;
    } else if (digitsOnly.startsWith('0') && digitsOnly.length > 1) {
      // Remove leading 0 and add UAE country code
      cleanNumber = '+971' + digitsOnly.substring(1);
    } else if (digitsOnly.length >= 9) {
      // Assume it's a UAE number without country code
      cleanNumber = '+971' + digitsOnly;
    } else {
      // Fallback: add UAE country code
      cleanNumber = '+971' + digitsOnly;
    }
  } else {
    // It starts with '+', just clean it
    cleanNumber = '+' + cleanNumber.substring(1).replace(/\D/g, '');
  }
  
  // Basic validation - should contain only digits after prefix removal
  const digitsOnly = cleanNumber.replace(/^\+/, '');
  if (!/^\d{10,15}$/.test(digitsOnly)) {
    logError(`Invalid phone number format after processing: ${cleanNumber} (original: ${number})`);
    return null;
  }
  
  // Twilio WhatsApp API expects numbers in the format 'whatsapp:+E.164_NUMBER'
  return `whatsapp:${cleanNumber}`;
};

/**
 * Validate media URLs
 * Ensures media URLs are valid and accessible
 * 
 * @param {string|Array} mediaUrl - Single URL or array of URLs
 * @returns {Array} - Array of valid URLs
 */
const validateMediaUrls = (mediaUrl) => {
  if (!mediaUrl) return [];
  
  const urls = Array.isArray(mediaUrl) ? mediaUrl : [mediaUrl];
  const validUrls = [];
  
  for (const url of urls) {
    if (typeof url === 'string' && url.trim()) {
      try {
        new URL(url.trim()); // Validate URL format
        validUrls.push(url.trim());
      } catch (error) {
        logError(`Invalid media URL: ${url}`);
      }
    }
  }
  
  return validUrls;
};

/**
 * Create a new message document in the database
 * 
 * @param {Object} messageData - Message data object
 * @returns {Promise<Object>} - Created message document
 */
const createMessageDocument = async (messageData) => {
  try {
    const newMessage = new Message({
      ...messageData,
      timestamp: new Date(),
      createdAt: new Date(),
      updatedAt: new Date()
    });
    
    const savedMessage = await newMessage.save();
    logInfo(`Message document created: ${savedMessage._id}`);
    return savedMessage;
  } catch (error) {
    logError('Failed to create message document:', error);
    throw error;
  }
};

/**
 * Update message status in database
 * 
 * @param {string} messageId - Message document ID
 * @param {Object} updateData - Data to update
 * @returns {Promise<Object>} - Update result
 */
const updateMessageStatus = async (messageId, updateData) => {
  try {
    const result = await Message.updateOne(
      { _id: messageId },
      { 
        $set: { 
          ...updateData,
          updatedAt: new Date()
        }
      }
    );
    
    if (result.modifiedCount === 0) {
      logError(`Failed to update message: ${messageId} - Document not found or no changes made`);
    } else {
      logInfo(`Message updated successfully: ${messageId}`);
    }
    
    return result;
  } catch (error) {
    logError(`Error updating message ${messageId}:`, error);
    throw error;
  }
};

/**
 * Helper to strip whatsapp: prefix
 * @param {string} number - The phone number to strip.
 * @returns {string} - The phone number with the whatsapp: prefix removed.
 */
function stripWhatsappPrefix(number) {
  if (!number) return number;
  return number.replace(/^whatsapp:/, '');
}

/**
 * POST /send-message
 * Send WhatsApp message (text or media)
 * 
 * Request body:
 * - contactId: Unique identifier for the contact
 * - to: Recipient phone number (E.164 format recommended)
 * - body: Message text content (required if no mediaUrl)
 * - mediaUrl: Media URL or array of URLs (required if no body)
 * - contactName: Display name for the contact
 * - fromName: Sender name (defaults to 'Salesforce User')
 */
router.post('/send-message', async (req, res) => {
  try {
    const { 
      contactId, 
      to, 
      body, 
      mediaUrl, 
      contactName, 
      fromName = 'Salesforce User' 
    } = req.body;

    // Input validation
    if (!contactId || typeof contactId !== 'string') {
      return res.status(400).json({ 
        success: false, 
        error: 'contactId is required and must be a string' 
      });
    }

    if (!to || typeof to !== 'string') {
      return res.status(400).json({ 
        success: false, 
        error: 'to is required and must be a valid phone number' 
      });
    }

    if (!body && !mediaUrl) {
      return res.status(400).json({ 
        success: false, 
        error: 'Either body or mediaUrl is required' 
      });
    }

    // Format and validate phone numbers
    const formattedTo = formatPhoneNumber(to);
    if (!formattedTo) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid recipient phone number format. Use E.164 format (e.g., +1234567890)' 
      });
    }

    const fromNumber = formatPhoneNumber(process.env.TWILIO_FROM_NUMBER);
    if (!fromNumber) {
      logError('TWILIO_FROM_NUMBER environment variable is not configured or invalid');
      return res.status(500).json({ 
        success: false, 
        error: 'Server configuration error: FROM_NUMBER not configured' 
      });
    }

    // Validate media URLs if provided
    const validMediaUrls = validateMediaUrls(mediaUrl);
    if (mediaUrl && validMediaUrls.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid media URL(s) provided' 
      });
    }

    // Create initial message document with temporary SID
    const tempMessageSid = `tw_${uuidv4()}`;
    const messageData = {
      messageSid: tempMessageSid,
      contactId: contactId.trim(),
      contactName: contactName?.trim() || 'Unknown',
      fromName: fromName?.trim() || 'Salesforce User',
      message: body?.trim() || '',
      mediaUrl: validMediaUrls,
      direction: 'outbound',
      status: 'queued',
      from: stripWhatsappPrefix(fromNumber),
      to: stripWhatsappPrefix(formattedTo),
      messageType: validMediaUrls.length > 0 ? 'media' : 'text'
    };

    const newMessage = await createMessageDocument(messageData);

    // Construct status callback URL with fallback
    const apiBaseUrl = process.env.API_BASE_URL || 'https://whatsappwidget-be.onrender.com';
    const statusCallbackUrl = `${apiBaseUrl}/webhook/status`;

    // Prepare Twilio message options
    const messageOptions = {
      from: fromNumber, // Keep whatsapp: prefix for Twilio API
      to: formattedTo,  // Keep whatsapp: prefix for Twilio API
      statusCallback: statusCallbackUrl
    };

    // Add body if provided
    if (body?.trim()) {
      messageOptions.body = body.trim();
    }

    // Add media URLs if provided
    if (validMediaUrls.length > 0) {
      messageOptions.mediaUrl = validMediaUrls;
    }

    // Send message via Twilio with retry logic
    logInfo(`Sending message to ${formattedTo} for contact ${contactId}`);
    const { success, message, error } = await sendWithRetry(messageOptions);

    // Update message document based on result
    if (success) {
      await updateMessageStatus(newMessage._id, {
        messageSid: message.sid,
        status: 'sent',
        sentAt: new Date()
      });

      logInfo(`Message sent successfully: ${message.sid} to ${formattedTo}`);
      
      res.status(202).json({
        success: true,
        message: 'Message sent successfully',
        data: { 
          messageId: newMessage._id,
          messageSid: message.sid,
          status: 'sent',
          contactId,
          to: formattedTo
        }
      });
    } else {
      await updateMessageStatus(newMessage._id, {
        status: 'failed',
        errorCode: error.code || 'UNKNOWN_ERROR',
        errorMessage: error.message || 'Unknown error occurred',
        failedAt: new Date()
      });

      logError(`Failed to send message to ${formattedTo}: ${error.message} (Code: ${error.code})`);
      
      res.status(500).json({ 
        success: false, 
        error: `Failed to send message: ${error.message}`,
        errorCode: error.code
      });
    }

  } catch (error) {
    logError('Error in send-message endpoint:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error while sending message' 
    });
  }
});

/**
 * POST /send-template
 * Send WhatsApp template message
 * 
 * Request body:
 * - contactId: Unique identifier for the contact
 * - to: Recipient phone number (E.164 format recommended)
 * - contentSid: Twilio Content Template SID
 * - contentVariables: Object/Array of template variables
 * - contactName: Display name for the contact
 * - fromName: Sender name (defaults to 'Salesforce User')
 */
router.post('/send-template', async (req, res) => {
  try {
    const { contactId, to, contentSid, contentVariables, contactName, fromName = 'Salesforce User' } = req.body;

    if (!contactId || !to || !contentSid) {
      return res.status(400).json({ success: false, error: 'contactId, to, and contentSid are required' });
    }

    const formattedTo = formatPhoneNumber(to);
    if (!formattedTo) {
      return res.status(400).json({ success: false, error: 'Invalid to number format' });
    }

    const fromNumber = formatPhoneNumber(process.env.TWILIO_FROM_NUMBER);
    if (!fromNumber) {
      return res.status(500).json({ success: false, error: 'TWILIO_FROM_NUMBER is not configured' });
    }

    const tempMessageSid = `tw_${uuidv4()}`;
    const newMessage = new Message({
      messageSid: tempMessageSid,
      contactId,
      contactName: contactName || 'Unknown',
      contentSid,
      contentVariables: contentVariables || {},
      fromName,
      direction: 'outbound',
      status: 'queued',
      from: stripWhatsappPrefix(fromNumber),
      to: stripWhatsappPrefix(formattedTo),
      messageType: 'template'
    });
    await newMessage.save();

    const apiBaseUrl = process.env.API_BASE_URL || 'https://whatsappwidget-be.onrender.com';
    const statusCallbackUrl = `${apiBaseUrl}/webhook/status`;

    let contentVars = {};
    if (!contentVariables) {
      contentVars = { "1": "696969" };
    } else if (Array.isArray(contentVariables)) {
      contentVariables.forEach((val, idx) => {
        contentVars[`${idx + 1}`] = val;
      });
    } else if (typeof contentVariables === 'object' && contentVariables !== null) {
      contentVars = { ...contentVariables };
    }

    const messageOptions = {
      from: stripWhatsappPrefix(fromNumber),
      to: stripWhatsappPrefix(formattedTo),
      contentSid,
      contentVariables: JSON.stringify(contentVars),
      statusCallback: statusCallbackUrl
    };
    const { success, message, error } = await sendWithRetry(messageOptions);

    if (success) {
      // Fetch the actual message body from Twilio
      const fetchedMessage = await twilioClient.messages(message.sid).fetch();

      await Message.updateOne({ _id: newMessage._id }, {
        $set: { 
          messageSid: message.sid, 
          status: 'sent', 
          sentAt: new Date(),
          message: fetchedMessage.body || ''
        }
      });
      logInfo(`Template sent successfully: ${message.sid}`);
      res.status(202).json({
        success: true,
        message: 'Template sent successfully',
        data: { messageSid: message.sid, status: 'sent' }
      });
    } else {
      await Message.updateOne({ _id: newMessage._id }, {
        $set: { status: 'failed', errorCode: error.code, errorMessage: error.message, failedAt: new Date() }
      });
      logError(`Failed to send template: ${error.message} (Code: ${error.code})`);
      res.status(500).json({ success: false, error: `Failed to send template: ${error.message}` });
    }
  } catch (error) {
    logError('Error in send-template endpoint:', error);
    res.status(500).json({ success: false, error: 'Internal server error while sending template' });
  }
});

/**
 * GET / (mounted at /messages)
 * Get messages with pagination and filtering
 * 
 * Query parameters:
 * - contactId: Filter by contact ID
 * - status: Filter by message status
 * - direction: Filter by message direction (inbound/outbound)
 * - startDate: Filter messages after this date (ISO format)
 * - endDate: Filter messages before this date (ISO format)
 * - page: Page number (default: 1)
 * - limit: Number of messages per page (default: 20, max: 100)
 */
router.get('/', async (req, res) => {
  // Fallback for direct browser access (no query params)
  if (Object.keys(req.query).length === 0) {
    return res.status(200).send('<h2>WhatsApp Widget API</h2><p>Use this endpoint with query parameters (e.g. ?contactId=... or ?phone=...)</p>');
  }
  try {
    const { 
      contactId, 
      phone, // allow phone number as a query param
      status, 
      direction, 
      startDate, 
      endDate, 
      page = 1, 
      limit = 20 
    } = req.query;

    // Input validation
    const pageNum = parseInt(page);
    const limitNum = Math.min(parseInt(limit), 100); // Cap limit at 100

    if (pageNum < 1 || limitNum < 1) {
      return res.status(400).json({ 
        success: false, 
        error: 'Page and limit must be positive integers' 
      });
    }

    // Build query object
    const query = {};
    if (contactId) {
      query.contactId = contactId.trim();
    }
    // Support phone number as a fallback (normalize for both from/to)
    if (phone) {
      const normalizedPhone = phone.replace(/[^\d]/g, '');
      query.$or = [
        { from: new RegExp(normalizedPhone, 'i') },
        { to: new RegExp(normalizedPhone, 'i') }
      ];
    }
    if (status) {
      query.status = status.trim();
    }
    if (direction && ['inbound', 'outbound'].includes(direction.toLowerCase())) {
      query.direction = direction.toLowerCase();
    }
    // Date range filtering
    if (startDate || endDate) {
      query.timestamp = {};
      if (startDate) {
        const start = new Date(startDate);
        if (isNaN(start.getTime())) {
          return res.status(400).json({ 
            success: false, 
            error: 'Invalid startDate format. Use ISO format (YYYY-MM-DDTHH:mm:ss.sssZ)' 
          });
        }
        query.timestamp.$gte = start;
      }
      if (endDate) {
        const end = new Date(endDate);
        if (isNaN(end.getTime())) {
          return res.status(400).json({ 
            success: false, 
            error: 'Invalid endDate format. Use ISO format (YYYY-MM-DDTHH:mm:ss.sssZ)' 
          });
        }
        query.timestamp.$lte = end;
      }
    }
    // Execute query with pagination
    const skip = (pageNum - 1) * limitNum;
    const [total, messages] = await Promise.all([
      Message.countDocuments(query),
      Message.find(query)
        .sort({ timestamp: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean()
    ]);
    // Get contact name from the first message
    const contactName = messages.length > 0 
      ? (messages[0].contactName || messages[0].fromName || 'Unknown Contact')
      : null;
    const totalPages = Math.ceil(total / limitNum);
    logInfo(`Retrieved ${messages.length} messages for query: ${JSON.stringify(query)}`);
    res.json({
      success: true,
      data: messages,
      contactName,
      pagination: { 
        total,
        page: pageNum,
        totalPages,
        limit: limitNum,
        hasNextPage: pageNum < totalPages,
        hasPrevPage: pageNum > 1
      }
    });
  } catch (error) {
    logError('Error fetching messages:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch messages' 
    });
  }
});

/**
 * PATCH /read
 * Mark messages as read
 * 
 * Request body:
 * - messageIds: Array of message IDs to mark as read (optional if contactId provided)
 * - contactId: Contact ID to mark all unread inbound messages as read (optional if messageIds provided)
 */
router.patch('/read', async (req, res) => {
  try {
    const { messageIds, contactId } = req.body;

    // Input validation
    if (!messageIds?.length && !contactId) {
      return res.status(400).json({ 
        success: false, 
        error: 'Either messageIds array or contactId is required' 
      });
    }

    // Validate messageIds if provided
    if (messageIds && (!Array.isArray(messageIds) || messageIds.length === 0)) {
      return res.status(400).json({ 
        success: false, 
        error: 'messageIds must be a non-empty array' 
      });
    }

    // Build query based on provided parameters
    let query;
    if (messageIds?.length) {
      query = { _id: { $in: messageIds } };
      logInfo(`Marking ${messageIds.length} specific messages as read`);
    } else {
      query = { 
        contactId: contactId.trim(), 
        direction: 'inbound', 
        isRead: { $ne: true } 
      };
      logInfo(`Marking all unread inbound messages as read for contact: ${contactId}`);
    }

    // Update messages
    const result = await Message.updateMany(
      query,
      { 
        $set: { 
          isRead: true, 
          readAt: new Date(), 
          status: 'read',
          updatedAt: new Date()
        } 
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'No matching messages found to mark as read' 
      });
    }

    logInfo(`Marked ${result.modifiedCount} out of ${result.matchedCount} messages as read`);

    res.json({ 
      success: true, 
      message: `Successfully marked ${result.modifiedCount} messages as read`,
      data: { 
        matchedCount: result.matchedCount, 
        modifiedCount: result.modifiedCount 
      } 
    });

  } catch (error) {
    logError('Error marking messages as read:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to mark messages as read' 
    });
  }
});

/**
 * GET /:messageId/status
 * Get message status by message ID or Twilio SID
 * 
 * Supports both internal message ID and Twilio message SID
 */
router.get('/:messageId/status', async (req, res) => {
  try {
    const { messageId } = req.params;

    // Input validation
    if (!messageId || typeof messageId !== 'string') {
      return res.status(400).json({ 
        success: false, 
        error: 'messageId is required and must be a string' 
      });
    }

    // Find message by either internal ID or Twilio SID
    const message = await Message.findOne({ 
      $or: [
        { _id: messageId.trim() }, 
        { messageSid: messageId.trim() }
      ] 
    }).lean();

    if (!message) {
      logInfo(`Message not found: ${messageId}`);
      return res.status(404).json({ 
        success: false, 
        error: 'Message not found' 
      });
    }

    logInfo(`Message status retrieved: ${messageId} - Status: ${message.status}`);

    res.json({
      success: true,
      data: {
        messageId: message._id,
        messageSid: message.messageSid,
        status: message.status,
        contactId: message.contactId,
        direction: message.direction,
        messageType: message.messageType,
        timestamp: message.timestamp,
        sentAt: message.sentAt,
        readAt: message.readAt,
        failedAt: message.failedAt,
        error: message.errorMessage ? { 
          code: message.errorCode, 
          message: message.errorMessage 
        } : undefined
      }
    });

  } catch (error) {
    logError('Error getting message status:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to get message status' 
    });
  }
});

/**
 * Global error handler for the router
 * Catches any unhandled errors and returns a consistent error response
 */
router.use((error, req, res, next) => {
  logError('Unhandled error in WhatsApp routes:', error);
  
  if (!res.headersSent) {
    res.status(500).json({
      success: false,
      error: 'An unexpected error occurred',
      requestId: req.headers['x-request-id'] || 'unknown'
    });
  }
});

export default router;
