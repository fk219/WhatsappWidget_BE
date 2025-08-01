
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
  logInfo('Twilio client initialized successfully');
} catch (error) {
  logError('Failed to initialize Twilio client:', error);
  process.exit(1); // Exit if Twilio cannot be initialized
}

/**
 * Helper function to emit socket events safely
 * @param {Object} io - Socket.io instance
 * @param {string} contactId - Contact ID to emit to
 * @param {string} event - Event name
 * @param {Object} data - Data to emit
 */
const emitSocketEvent = (io, contactId, event, data) => {
  try {
    if (io && contactId) {
      io.to(contactId).emit(event, data);
      logInfo(`Socket event '${event}' emitted to contact: ${contactId}`);
    }
  } catch (error) {
    logError('Error emitting socket event:', error);
  }
};

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
  
  return `whatsapp:+${formattedNumber}`;
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
      const updatedMessageData = {
        messageSid: message.sid,
        status: 'sent',
        sentAt: new Date()
      };
      
      await updateMessageStatus(newMessage._id, updatedMessageData);

      // Emit socket event for real-time updates
        const io = req.app.get('socketio');
        const messageForSocket = {
          ...newMessage.toObject(),
          ...updatedMessageData
        };
        emitSocketEvent(io, contactId, 'new-message', messageForSocket);

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
      const errorData = {
        status: 'failed',
        errorCode: error.code || 'UNKNOWN_ERROR',
        errorMessage: error.message || 'Unknown error occurred',
        failedAt: new Date()
      };
      
      await updateMessageStatus(newMessage._id, errorData);

      // Emit socket event for failed message
      const io = req.app.get('socketio');
      const messageForSocket = {
        ...newMessage.toObject(),
        ...errorData
      };
      emitSocketEvent(io, contactId, 'message-status-update', messageForSocket);

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

    // Create initial message document
    const tempMessageSid = `tw_${uuidv4()}`;
    const messageData = {
      messageSid: tempMessageSid,
      contactId: contactId.trim(),
      contactName: contactName?.trim() || 'Unknown',
      contentSid: contentSid.trim(),
      contentVariables: contentVariables || {},
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

    // Format content variables for Twilio
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

    // Prepare Twilio template message options
    const messageOptions = {
      from: fromNumber,
      to: formattedTo,
      contentSid: contentSid.trim(),
      contentVariables: JSON.stringify(contentVars),
      statusCallback: statusCallbackUrl
    };

    // Send template via Twilio with retry logic
    logInfo(`Sending template ${contentSid} to ${formattedTo} for contact ${contactId}`);
    const { success, message, error } = await sendWithRetry(messageOptions);

    // Update message document based on result
    if (success) {
      try {
        // Fetch the actual message body from Twilio
        const fetchedMessage = await twilioClient.messages(message.sid).fetch();
        
        const updatedMessageData = {
          messageSid: message.sid,
          status: 'sent',
          sentAt: new Date(),
          message: fetchedMessage.body || ''
        };
        
        await updateMessageStatus(newMessage._id, updatedMessageData);

        // Emit socket event for real-time updates
        const io = req.app.get('socketio');
        const messageForSocket = {
          ...newMessage.toObject(),
          ...updatedMessageData
        };
        emitSocketEvent(io, contactId, 'new-message', messageForSocket);

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
      } catch (fetchError) {
        logError('Error fetching message details from Twilio:', fetchError);
        // Still return success as the message was sent
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
      }
    } else {
      const errorData = {
        status: 'failed',
        errorCode: error.code || 'UNKNOWN_ERROR',
        errorMessage: error.message || 'Unknown error occurred',
        failedAt: new Date()
      };
      
      await updateMessageStatus(newMessage._id, errorData);

      // Emit socket event for failed template
      const io = req.app.get('socketio');
      const messageForSocket = {
        ...newMessage.toObject(),
        ...errorData
      };
      emitSocketEvent(io, contactId, 'message-status-update', messageForSocket);

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
      // Get unread message count
      const unreadCount = await Message.countDocuments({ 
        contactId: contactId.trim(),
        direction: 'inbound',
        isRead: { $ne: true }
      });

      // Get total message count
      const totalMessageCount = await Message.countDocuments({ 
        contactId: contactId.trim() 
      });

      logInfo(`Contact found: ${contactId}`);
      return res.json({
        success: true,
        data: {
          contactId,
          name: contactMessage.contactName || contactMessage.fromName || 'Unknown Contact',
          phone: contactMessage.direction === 'inbound' ? contactMessage.from : contactMessage.to,
          lastMessageDate: contactMessage.timestamp,
          messageCount: totalMessageCount,
          unreadCount,
          lastMessage: {
            text: contactMessage.message,
            direction: contactMessage.direction,
            timestamp: contactMessage.timestamp,
            status: contactMessage.status
          }
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
 * GET /contacts
 * Get all contacts with their latest message info
 * Query parameters:
 * - page: Page number (default: 1)
 * - limit: Number of contacts per page (default: 20, max: 100)
 * - search: Search term for contact name or phone number
 */
router.get('/contacts', async (req, res) => {
  try {
    const { page = 1, limit = 20, search } = req.query;
    
    // Input validation
    const pageNum = parseInt(page);
    const limitNum = Math.min(parseInt(limit), 100);

    if (pageNum < 1 || limitNum < 1) {
      return res.status(400).json({ 
        success: false, 
        error: 'Page and limit must be positive integers' 
      });
    }

    // Build aggregation pipeline
    const pipeline = [
      {
        $sort: { timestamp: -1 }
      },
      {
        $group: {
          _id: '$contactId',
          latestMessage: { $first: '$$ROOT' },
          messageCount: { $sum: 1 },
          unreadCount: {
            $sum: {
              $cond: [
                { 
                  $and: [
                    { $eq: ['$direction', 'inbound'] },
                    { $ne: ['$isRead', true] }
                  ]
                },
                1,
                0
              ]
            }
          }
        }
      }
    ];

    // Add search filter if provided
    if (search && search.trim()) {
      const searchRegex = new RegExp(search.trim(), 'i');
      pipeline.push({
        $match: {
          $or: [
            { 'latestMessage.contactName': { $regex: searchRegex } },
            { 'latestMessage.fromName': { $regex: searchRegex } },
            { 'latestMessage.from': { $regex: searchRegex } },
            { 'latestMessage.to': { $regex: searchRegex } }
          ]
        }
      });
    }

    // Add pagination
    const skip = (pageNum - 1) * limitNum;
    pipeline.push(
      { $sort: { 'latestMessage.timestamp': -1 } },
      { $skip: skip },
      { $limit: limitNum }
    );

    const contacts = await Message.aggregate(pipeline);

    // Get total count for pagination
    const countPipeline = [
      {
        $group: {
          _id: '$contactId',
          latestMessage: { $first: '$$ROOT' }
        }
      }
    ];

    if (search && search.trim()) {
      const searchRegex = new RegExp(search.trim(), 'i');
      countPipeline.push({
        $match: {
          $or: [
            { 'latestMessage.contactName': { $regex: searchRegex } },
            { 'latestMessage.fromName': { $regex: searchRegex } },
            { 'latestMessage.from': { $regex: searchRegex } },
            { 'latestMessage.to': { $regex: searchRegex } }
          ]
        }
      });
    }

    const totalContacts = await Message.aggregate([
      ...countPipeline,
      { $count: 'total' }
    ]);

    const total = totalContacts.length > 0 ? totalContacts[0].total : 0;
    const totalPages = Math.ceil(total / limitNum);

    // Format response
    const formattedContacts = contacts.map(contact => ({
      contactId: contact._id,
      name: contact.latestMessage.contactName || contact.latestMessage.fromName || 'Unknown Contact',
      phone: contact.latestMessage.direction === 'inbound' ? contact.latestMessage.from : contact.latestMessage.to,
      lastMessageDate: contact.latestMessage.timestamp,
      messageCount: contact.messageCount,
      unreadCount: contact.unreadCount,
      lastMessage: {
        text: contact.latestMessage.message,
        direction: contact.latestMessage.direction,
        timestamp: contact.latestMessage.timestamp,
        status: contact.latestMessage.status
      }
    }));

    logInfo(`Retrieved ${formattedContacts.length} contacts`);

    res.json({
      success: true,
      data: formattedContacts,
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
    logError('Error fetching contacts:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch contacts' 
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

    // Emit socket event for real-time updates
    const io = req.app.get('socketio');
    if (contactId) {
      emitSocketEvent(io, contactId.trim(), 'messages-read', {
        contactId: contactId.trim(),
        readCount: result.modifiedCount
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
 * DELETE /messages/:messageId
 * Delete a specific message
 */
router.delete('/messages/:messageId', async (req, res) => {
  try {
    const { messageId } = req.params;

    // Input validation
    if (!messageId || typeof messageId !== 'string') {
      return res.status(400).json({ 
        success: false, 
        error: 'messageId is required and must be a string' 
      });
    }

    // Find and delete the message
    const deletedMessage = await Message.findByIdAndDelete(messageId.trim());

    if (!deletedMessage) {
      return res.status(404).json({ 
        success: false, 
        error: 'Message not found' 
      });
    }

    // Emit socket event for real-time updates
    const io = req.app.get('socketio');
    emitSocketEvent(io, deletedMessage.contactId, 'message-deleted', {
      messageId: deletedMessage._id,
      contactId: deletedMessage.contactId
    });

    logInfo(`Message deleted: ${messageId}`);

    res.json({ 
      success: true, 
      message: 'Message deleted successfully',
      data: { messageId: deletedMessage._id }
    });

  } catch (error) {
    logError('Error deleting message:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to delete message' 
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
 * POST /messages/:messageId/retry
 * Retry sending a failed message
 */
router.post('/messages/:messageId/retry', async (req, res) => {
  try {
    const { messageId } = req.params;

    // Input validation
    if (!messageId || typeof messageId !== 'string') {
      return res.status(400).json({ 
        success: false, 
        error: 'messageId is required and must be a string' 
      });
    }

    // Find the failed message
    const message = await Message.findById(messageId.trim());

    if (!message) {
      return res.status(404).json({ 
        success: false, 
        error: 'Message not found' 
      });
    }

    if (message.status !== 'failed') {
      return res.status(400).json({ 
        success: false, 
        error: 'Only failed messages can be retried' 
      });
    }

    // Construct status callback URL
    const apiBaseUrl = process.env.API_BASE_URL || 'https://whatsappwidget-be.onrender.com';
    const statusCallbackUrl = `${apiBaseUrl}/webhook/status`;

    // Prepare message options based on message type
    const messageOptions = {
      from: message.from,
      to: message.to,
      statusCallback: statusCallbackUrl
    };

    if (message.messageType === 'template') {
      messageOptions.contentSid = message.contentSid;
      messageOptions.contentVariables = JSON.stringify(message.contentVariables || {});
    } else {
      if (message.message) {
        messageOptions.body = message.message;
      }
      if (message.mediaUrl && message.mediaUrl.length > 0) {
        messageOptions.mediaUrl = message.mediaUrl;
      }
    }

    // Update message status to queued
    await updateMessageStatus(message._id, { 
      status: 'queued', 
      errorCode: null, 
      errorMessage: null, 
      failedAt: null 
    });

    // Retry sending the message
    logInfo(`Retrying message: ${messageId}`);
    const { success, message: twilioMessage, error } = await sendWithRetry(messageOptions);

    if (success) {
      const updatedData = {
        messageSid: twilioMessage.sid,
        status: 'sent',
        sentAt: new Date()
      };
      
      await updateMessageStatus(message._id, updatedData);

      // Emit socket event
      const io = req.app.get('socketio');
      const messageForSocket = {
        ...message.toObject(),
        ...updatedData
      };
      emitSocketEvent(io, message.contactId, 'message-retry-success', messageForSocket);

      logInfo(`Message retry successful: ${twilioMessage.sid}`);
      
      res.json({
        success: true,
        message: 'Message retry successful',
        data: { 
          messageId: message._id,
          messageSid: twilioMessage.sid,
          status: 'sent'
        }
      });
    } else {
      const errorData = {
        status: 'failed',
        errorCode: error.code || 'UNKNOWN_ERROR',
        errorMessage: error.message || 'Unknown error occurred',
        failedAt: new Date()
      };
      
      await updateMessageStatus(message._id, errorData);

      // Emit socket event
      const io = req.app.get('socketio');
      const messageForSocket = {
        ...message.toObject(),
        ...errorData
      };
      emitSocketEvent(io, message.contactId, 'message-retry-failed', messageForSocket);

      logError(`Message retry failed: ${error.message} (Code: ${error.code})`);
      
      res.status(500).json({ 
        success: false, 
        error: `Message retry failed: ${error.message}`,
        errorCode: error.code
      });
    }

  } catch (error) {
    logError('Error retrying message:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to retry message' 
    });
  }
});

/**
 * GET /analytics/summary
 * Get analytics summary for messages
 * Query parameters:
 * - startDate: Start date for analytics (ISO format)
 * - endDate: End date for analytics (ISO format)
 * - contactId: Optional contact ID filter
 */
router.get('/analytics/summary', async (req, res) => {
  try {
    const { startDate, endDate, contactId } = req.query;

    // Build query for date range
    const query = {};
    
    if (startDate || endDate) {
      query.timestamp = {};
      
      if (startDate) {
        const start = new Date(startDate);
        if (isNaN(start.getTime())) {
          return res.status(400).json({ 
            success: false, 
            error: 'Invalid startDate format' 
          });
        }
        query.timestamp.$gte = start;
      }
      
      if (endDate) {
        const end = new Date(endDate);
        if (isNaN(end.getTime())) {
          return res.status(400).json({ 
            success: false, 
            error: 'Invalid endDate format' 
          });
        }
        query.timestamp.$lte = end;
      }
    }

    if (contactId) {
      query.contactId = contactId.trim();
    }

    // Aggregate analytics data
    const analytics = await Message.aggregate([
      { $match: query },
      {
        $group: {
          _id: null,
          totalMessages: { $sum: 1 },
          sentMessages: {
            $sum: { $cond: [{ $eq: ['$status', 'sent'] }, 1, 0] }
          },
          failedMessages: {
            $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] }
          },
          inboundMessages: {
            $sum: { $cond: [{ $eq: ['$direction', 'inbound'] }, 1, 0] }
          },
          outboundMessages: {
            $sum: { $cond: [{ $eq: ['$direction', 'outbound'] }, 1, 0] }
          },
          textMessages: {
            $sum: { $cond: [{ $eq: ['$messageType', 'text'] }, 1, 0] }
          },
          mediaMessages: {
            $sum: { $cond: [{ $eq: ['$messageType', 'media'] }, 1, 0] }
          },
          templateMessages: {
            $sum: { $cond: [{ $eq: ['$messageType', 'template'] }, 1, 0] }
          },
          unreadMessages: {
            $sum: { 
              $cond: [
                { 
                  $and: [
                    { $eq: ['$direction', 'inbound'] },
                    { $ne: ['$isRead', true] }
                  ]
                }, 
                1, 
                0
              ] 
            }
          }
        }
      }
    ]);

    // Get unique contacts count
    const uniqueContacts = await Message.distinct('contactId', query);

    const summary = analytics.length > 0 ? analytics[0] : {
      totalMessages: 0,
      sentMessages: 0,
      failedMessages: 0,
      inboundMessages: 0,
      outboundMessages: 0,
      textMessages: 0,
      mediaMessages: 0,
      templateMessages: 0,
      unreadMessages: 0
    };

    // Remove the _id field and add additional metrics
    delete summary._id;
    summary.uniqueContacts = uniqueContacts.length;
    summary.successRate = summary.totalMessages > 0 
      ? ((summary.sentMessages / summary.totalMessages) * 100).toFixed(2)
      : '0.00';

    logInfo('Analytics summary generated');

    res.json({
      success: true,
      data: summary,
      dateRange: {
        startDate: startDate || null,
        endDate: endDate || null
      }
    });

  } catch (error) {
    logError('Error generating analytics summary:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to generate analytics summary' 
    });
  }
});

/**
 * GET /health
 * Health check endpoint
 */
router.get('/health', async (req, res) => {
  try {
    // Check database connectivity
    const messageCount = await Message.estimatedDocumentCount();
    
    // Check Twilio connectivity (optional)
    let twilioStatus = 'unknown';
    try {
      if (twilioClient) {
        await twilioClient.api.accounts(process.env.TWILIO_ACCOUNT_SID).fetch();
        twilioStatus = 'connected';
      }
    } catch (twilioError) {
      twilioStatus = 'error';
      logError('Twilio health check failed:', twilioError);
    }

    res.json({
      success: true,
      status: 'healthy',
      timestamp: new Date().toISOString(),
      services: {
        database: 'connected',
        twilio: twilioStatus
      },
      stats: {
        totalMessages: messageCount
      }
    });

  } catch (error) {
    logError('Health check failed:', error);
    res.status(500).json({
      success: false,
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: 'Health check failed'
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
