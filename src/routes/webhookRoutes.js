// src/routes/webhookRoutes.js
import express from 'express';
import Message from '../models/Message.js';
import { logInfo, logError } from '../utils/logger.js';

const router = express.Router();

router.post('/incoming', async (req, res) => {
  try {
    logInfo('Processing incoming message webhook', { body: req.body });

    const { MessageSid, From, To, Body, NumMedia, ProfileName, WaId } = req.body;

    if (!MessageSid) {
      logError('Missing MessageSid in incoming webhook', { body: req.body });
      return res.status(400).send('Bad Request');
    }

    const cleanFrom = From.replace('whatsapp:', '');
    const cleanTo = To.replace('whatsapp:', '');
    const contactName = ProfileName || cleanFrom;

    let message = await Message.findOne({ messageSid: MessageSid });
    if (!message) {
      const now = new Date();
      message = new Message({
        messageSid: MessageSid,
        contactId: cleanFrom,
        contactName,
        fromName: contactName || 'Unknown',
        message: Body,
        direction: 'inbound',
        status: 'received',
        isRead: false,
        from: From,
        to: To,
        timestamp: now,
        deliveredAt: now,
        mediaUrl: []
      });

      // Handle media
      for (let i = 0; i < parseInt(NumMedia || 0); i++) {
        if (req.body[`MediaUrl${i}`]) {
          message.mediaUrl.push(req.body[`MediaUrl${i}`]);
        }
      }

      await message.save();
      logInfo(`Incoming message saved: ${MessageSid}`);
    } else {
      // Update if needed
      await Message.updateOne({ messageSid: MessageSid }, { $set: { status: 'received' } });
    }

    res.sendStatus(200);
  } catch (error) {
    logError('Error processing incoming webhook:', error);
    res.sendStatus(500);
  }
});

router.post('/status', async (req, res) => {
  try {
    const { MessageSid, MessageStatus, To, From } = req.body;

    if (!MessageSid || !MessageStatus) {
      logError('Invalid webhook data:', req.body);
      return res.status(400).send('Invalid webhook data');
    }

    logInfo(`Processing status webhook for MessageSid: ${MessageSid}, Status: ${MessageStatus}`);

    // Update the message document
    const update = {
      status: MessageStatus.toLowerCase(),
      updatedAt: new Date()
    };
    if (MessageStatus === 'delivered') update.deliveredAt = new Date();
    if (MessageStatus === 'read') {
      update.readAt = new Date();
      update.isRead = true;
    }
    if (['failed', 'undelivered'].includes(MessageStatus)) {
      update.failedAt = new Date();
      update.errorCode = req.body.ErrorCode || 'UNKNOWN';
      update.errorMessage = req.body.ErrorMessage || 'Delivery failed';
    }

    const result = await Message.updateOne({ messageSid: MessageSid }, { $set: update });

    if (result.matchedCount > 0) {
      logInfo(`Message updated successfully: ${MessageSid}`);
    } else {
      logError(`No message found for MessageSid: ${MessageSid}`);
    }

    res.sendStatus(200); // Acknowledge the webhook
  } catch (error) {
    logError('Error processing status webhook:', error);
    res.sendStatus(500); // Ensure Twilio retries on failure
  }
});

export default router;
