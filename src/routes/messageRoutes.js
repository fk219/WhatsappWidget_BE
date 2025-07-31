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
  const cleanNumber = number.trim();
  
  // Return as-is if already in WhatsApp format
  if (cleanNumber.startsWith('whatsapp:')) {
    return cleanNumber;
  }
  
  // Remove international prefixes (+, 00) and format for WhatsApp
  // This handles various international number formats
  const formattedNumber = cleanNumber.replace(/^(\+|00)/, '');
  
  // Basic validation - should contain only digits after prefix removal
  if (!/^\d{10,15}$/.test(formattedNumber)) {
    logError(`Invalid phone number format after processing: ${formattedNumber} (original: ${cleanNumber})`);
    return null;
  }
  
  return `whatsapp:${formattedNumber}`;
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
      from: fromNumber,
      to: formattedTo,
      messageType: validMediaUrls.length > 0 ? 'media' : 'text'
    };

    const newMessage = await createMessageDocument(messageData);

    // Construct status callback URL with fallback
    const apiBaseUrl = process.env.API_BASE_URL || 'https://whatsappwidget-be.onrender.com';
    const statusCallbackUrl = `${apiBaseUrl}/webhook/status`;

    // Prepare Twilio message options
    const messageOptions = {
      from: fromNumber,
      to: formattedTo,
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
    const { 
      contactId, 
      to, 
      contentSid, 
      contentVariables, 
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

    if (!contentSid || typeof contentSid !== 'string') {
      return res.status(400).json({ 
        success: false, 
        error: 'contentSid is required and must be a valid Twilio Content SID' 
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

    // Validate contentVariables if provided
    let validatedContentVariables = {};
    if (contentVariables) {
      if (typeof contentVariables === 'object') {
        validatedContentVariables = contentVariables;
      } else {
        return res.status(400).json({ 
          success: false, 
          error: 'contentVariables must be an object or array' 
        });
      }
    }

    // Create initial message document
    const tempMessageSid = `tw_${uuidv4()}`;
    const messageData = {
      messageSid: tempMessageSid,
      contactId: contactId.trim(),
      contactName: contactName?.trim() || 'Unknown',
      contentSid: contentSid.trim(),
      contentVariables: validatedContentVariables,
      fromName: fromName?.trim() || 'Salesforce User',
      direction: 'outbound',
      status: 'queued',
      from: fromNumber,
      to: formattedTo,
      messageType: 'template'
    };

    const newMessage = await createMessageDocument(messageData);

    // Construct status callback URL with fallback
    const apiBaseUrl = process.env.API_BASE_URL || 'https://whatsappwidget-be.onrender.com';
    const statusCallbackUrl = `${apiBaseUrl}/webhook/status`;

    // Prepare Twilio template message options
    const messageOptions = {
      from: fromNumber,
      to: formattedTo,
      contentSid: contentSid.trim(),
      contentVariables: Array.isArray(validatedContentVariables) 
        ? validatedContentVariables 
        : Object.values(validatedContentVariables), // Convert to array if object
      statusCallback: statusCallbackUrl
    };

    // Send template via Twilio with retry logic
    logInfo(`Sending template ${contentSid} to ${formattedTo} for contact ${contactId}`);
    const { success, message, error } = await sendWithRetry(messageOptions);

    // Update message document based on result
    if (success) {
      await updateMessageStatus(newMessage._id, {
        messageSid: message.sid,
        status: 'sent',
        sentAt: new Date()
      });

      logInfo(`Template sent successfully: ${message.sid} to ${formattedTo}`);
      
      res.status(202).json({
        success: true,
        message: 'Template sent successfully',
        data: { 
          messageId: newMessage._id,
          messageSid: message.sid,
          status: 'sent',
          contactId,
          contentSid,
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

      logError(`Failed to send template to ${formattedTo}: ${error.message} (Code: ${error.code})`);
      
      res.status(500).json({ 
        success: false, 
        error: `Failed to send template: ${error.message}`,
        errorCode: error.code
      });
    }

  } catch (error) {
    logError('Error in send-template endpoint:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error while sending template' 
    });
  }
});

/**
 * GET /contact/:contactId
 * Get contact details by contactId
 * Returns the most recent contact information from message history
 */
router.get('/contact/:contactId', async (req, res) => {
  try {
    const { contactId } = req.params;

    // Input validation
    if (!contactId || typeof contactId !== 'string') {
      return res.status(400).json({ 
        success: false, 
        error: 'contactId is required and must be a string' 
      });
    }

    // Find the most recent message for this contact
    const contactMessage = await Message.findOne({ 
      contactId: contactId.trim() 
    }).sort({ timestamp: -1 });

    if (contactMessage) {
      logInfo(`Contact found: ${contactId}`);
      return res.json({
        success: true,
        data: {
          contactId,
          name: contactMessage.contactName || contactMessage.fromName || 'Unknown Contact',
          phone: contactMessage.direction === 'inbound' ? contactMessage.from : contactMessage.to,
          lastMessageDate: contactMessage.timestamp,
          messageCount: await Message.countDocuments({ contactId: contactId.trim() })
        }
      });
    }

    logInfo(`Contact not found: ${contactId}`);
    res.status(404).json({ 
      success: false, 
      error: 'Contact not found' 
    });

  } catch (error) {
    logError('Error fetching contact details:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch contact details' 
    });
  }
});

/**
 * GET /messages
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
router.get('/messages', async (req, res) => {
  try {
    const { 
      contactId, 
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
        .lean() // Use lean() for better performance
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
 * PATCH /messages/read
 * Mark messages as read
 * 
 * Request body:
 * - messageIds: Array of message IDs to mark as read (optional if contactId provided)
 * - contactId: Contact ID to mark all unread inbound messages as read (optional if messageIds provided)
 */
router.patch('/messages/read', async (req, res) => {
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
 * GET /messages/:messageId/status
 * Get message status by message ID or Twilio SID
 * 
 * Supports both internal message ID and Twilio message SID
 */
router.get('/messages/:messageId/status', async (req, res) => {
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
