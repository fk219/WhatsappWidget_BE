import express from 'express';
import twilio from 'twilio';
import Message from '../models/Message.js';
import { v4 as uuidv4 } from 'uuid';
import { logInfo, logError } from '../utils/logger.js';

const router = express.Router();
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Helper function for retry logic with exponential backoff
const sendWithRetry = async (messageOptions, retryCount = 0, maxRetries = 3) => {
  try {
    const message = await twilioClient.messages.create(messageOptions);
    return { success: true, message };
  } catch (error) {
    if (retryCount < maxRetries) {
      const delay = Math.pow(2, retryCount) * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
      return sendWithRetry(messageOptions, retryCount + 1, maxRetries);
    }
    return { success: false, error };
  }
};

// Get contact details by contactId
router.get('/contact/:contactId', async (req, res) => {
  try {
    const { contactId } = req.params;
    const contactMessage = await Message.findOne({ contactId }).sort({ timestamp: -1 });
    if (contactMessage) {
      return res.json({
        success: true,
        name: contactMessage.contactName || contactMessage.fromName || 'Unknown Contact',
        phone: contactMessage.from || contactMessage.to
      });
    }
    res.status(404).json({ success: false, error: 'Contact not found' });
  } catch (error) {
    logError('Error fetching contact details:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch contact details' });
  }
});

// Get messages with pagination and filtering
router.get('/messages', async (req, res) => {
  try {
    const { contactId, status, direction, startDate, endDate, page = 1, limit = 20 } = req.query;
    const query = { contactId, status, direction };
    if (startDate || endDate) query.timestamp = {};
    if (startDate) query.timestamp.$gte = new Date(startDate);
    if (endDate) query.timestamp.$lte = new Date(endDate);

    const skip = (page - 1) * limit;
    const total = await Message.countDocuments(query);
    const messages = await Message.find(query).sort({ timestamp: -1 }).skip(skip).limit(parseInt(limit));
    const contactName = messages[0]?.contactName || messages[0]?.fromName || 'Unknown Contact';

    res.json({
      success: true,
      data: messages,
      contactName,
      pagination: { total, page: parseInt(page), totalPages: Math.ceil(total / limit), limit: parseInt(limit) }
    });
  } catch (error) {
    logError('Error fetching messages:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch messages' });
  }
});

// Send WhatsApp template message
router.post('/send-template', async (req, res) => {
  try {
    const { contactId, to, contentSid, contentVariables, contactName, fromName = 'System' } = req.body;
    if (!contactId || !to || !contentSid) return res.status(400).json({ success: false, error: 'Missing required fields' });

    const referenceId = `tw_${uuidv4()}`;
    const newMessage = new Message({
      messageSid: referenceId,
      contactId,
      contactName: contactName || 'Unknown',
      contentSid,
      contentVariables,
      direction: 'outbound',
      status: 'queued',
      from: process.env.TWILIO_FROM_NUMBER,
      fromName,
      to,
      messageType: 'template'
    });
    await newMessage.save();

    (async () => {
      const messageOptions = {
        from: `whatsapp:${process.env.TWILIO_FROM_NUMBER}`,
        to: `whatsapp:${to}`,
        contentSid,
        contentVariables: JSON.stringify(contentVariables || {}),
        statusCallback: `${process.env.API_BASE_URL}/webhook/status`
      };
      const { success, message, error } = await sendWithRetry(messageOptions);
      await Message.updateOne({ _id: newMessage._id }, {
        $set: success ? { messageSid: message.sid, status: 'sent', sentAt: new Date() } : { status: 'failed', errorCode: error.code, errorMessage: error.message, failedAt: new Date() }
      });
    })();

    res.status(202).json({ success: true, message: 'Message is being processed', data: newMessage });
  } catch (error) {
    logError('Error sending template message:', error);
    res.status(500).json({ success: false, error: 'Failed to send template message' });
  }
});

// Mark messages as read
router.patch('/messages/read', async (req, res) => {
  try {
    const { messageIds, contactId } = req.body;
    if (!messageIds?.length && !contactId) return res.status(400).json({ success: false, error: 'messageIds or contactId required' });

    const query = messageIds?.length ? { _id: { $in: messageIds } } : { contactId, direction: 'inbound', isRead: { $ne: true } };
    const result = await Message.updateMany(query, { $set: { isRead: true, readAt: new Date(), status: 'read' } });

    res.json({ success: true, data: { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount } });
  } catch (error) {
    logError('Error marking messages as read:', error);
    res.status(500).json({ success: false, error: 'Failed to mark messages as read' });
  }
});

// Get message status
router.get('/messages/:messageId/status', async (req, res) => {
  try {
    const { messageId } = req.params;
    const message = await Message.findOne({ $or: [{ _id: messageId }, { messageSid: messageId }] });
    if (!message) return res.status(404).json({ success: false, error: 'Message not found' });

    res.json({
      success: true,
      data: { status: message.status, messageSid: message.messageSid, timestamp: message.timestamp, error: message.errorMessage ? { code: message.errorCode, message: message.errorMessage } : undefined }
    });
  } catch (error) {
    logError('Error getting message status:', error);
    res.status(500).json({ success: false, error: 'Failed to get message status' });
  }
});

// Send direct WhatsApp message
router.post('/send-message', async (req, res) => {
  try {
    const { contactId, to, body, mediaUrl, contactName, fromName = 'Salesforce User' } = req.body;
    if (!contactId || !to || (!body && !mediaUrl)) return res.status(400).json({ success: false, error: 'contactId, to, and body or mediaUrl required' });

    const referenceId = `tw_${uuidv4()}`;
    const newMessage = new Message({
      messageSid: referenceId,
      contactId,
      contactName: contactName || 'Unknown',
      fromName,
      message: body,
      mediaUrl: mediaUrl ? [].concat(mediaUrl) : [],
      direction: 'outbound',
      status: 'queued',
      from: process.env.TWILIO_FROM_NUMBER,
      to,
      messageType: mediaUrl ? 'media' : 'text'
    });
    await newMessage.save();

    (async () => {
      const messageOptions = {
        from: `whatsapp:${process.env.TWILIO_FROM_NUMBER}`,
        to: `whatsapp:${to}`,
        body,
        mediaUrl: mediaUrl ? [].concat(mediaUrl) : undefined,
        statusCallback: `${process.env.API_BASE_URL}/webhook/status`
      };
      const { success, message, error } = await sendWithRetry(messageOptions);
      await Message.updateOne({ _id: newMessage._id }, {
        $set: success ? { messageSid: message.sid, status: 'sent', sentAt: new Date() } : { status: 'failed', errorCode: error.code, errorMessage: error.message, failedAt: new Date() }
      });
    })();

    res.status(202).json({ success: true, message: 'Message is being processed', data: newMessage });
  } catch (error) {
    logError('Error sending message:', error);
    res.status(500).json({ success: false, error: 'Failed to send message' });
  }
});

export default router;