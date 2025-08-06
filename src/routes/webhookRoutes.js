// src/routes/webhookRoutes.js
import express from 'express';
import Message from '../models/Message.js';
import { logInfo, logError } from '../utils/logger.js';

const router = express.Router();

// Helper function to look up Salesforce ContactId by WhatsApp number
async function lookupContactIdByPhone(phone) {
  // Clean the phone number for consistent matching
  const cleanPhone = phone.replace(/[^\d]/g, '');
  
  // Try to find the most recent outbound message to this phone
  const outbound = await Message.findOne({ 
    to: { $regex: cleanPhone, $options: 'i' }, 
    direction: 'outbound',
    contactId: { $regex: '^003' } // Ensure it's a Salesforce Contact ID
  }).sort({ timestamp: -1 });
  
  if (outbound && outbound.contactId && outbound.contactId.startsWith('003')) {
    logInfo(`Found Salesforce ContactId from outbound message: ${outbound.contactId} for phone: ${phone}`);
    return outbound.contactId;
  }
  
  // Try to find the most recent inbound message from this phone with a Salesforce contactId
  const inbound = await Message.findOne({ 
    from: { $regex: cleanPhone, $options: 'i' }, 
    direction: 'inbound', 
    contactId: { $regex: '^003' } 
  }).sort({ timestamp: -1 });
  
  if (inbound && inbound.contactId && inbound.contactId.startsWith('003')) {
    logInfo(`Found Salesforce ContactId from inbound message: ${inbound.contactId} for phone: ${phone}`);
    return inbound.contactId;
  }
  
  // Try broader search - any message with this phone number that has a Salesforce Contact ID
  const anyMessage = await Message.findOne({
    $or: [
      { from: { $regex: cleanPhone, $options: 'i' } },
      { to: { $regex: cleanPhone, $options: 'i' } }
    ],
    contactId: { $regex: '^003' }
  }).sort({ timestamp: -1 });
  
  if (anyMessage && anyMessage.contactId && anyMessage.contactId.startsWith('003')) {
    logInfo(`Found Salesforce ContactId from any message: ${anyMessage.contactId} for phone: ${phone}`);
    return anyMessage.contactId;
  }
  
  logError(`No Salesforce ContactId found for phone: ${phone}`);
  return null;
}

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

    // Lookup Salesforce ContactId by WhatsApp number
    let salesforceContactId = await lookupContactIdByPhone(cleanFrom);
    if (!salesforceContactId) {
      logError('No Salesforce ContactId found for incoming WhatsApp number', { cleanFrom });
      // Optionally, you could create a placeholder or skip saving
      // For now, fallback to using the phone number as contactId
      salesforceContactId = cleanFrom;
    }

    let message = await Message.findOne({ messageSid: MessageSid });
    if (!message) {
      const now = new Date();
      message = new Message({
        messageSid: MessageSid,
        contactId: salesforceContactId,
        contactName,
        fromName: contactName || 'Unknown',
        message: Body,
        direction: 'inbound',
        status: 'received',
        isRead: false,
        from: cleanFrom,
        to: cleanTo,
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
      // Don't log as error for status updates of messages we don't track
      // This is normal for messages sent outside our system
      logInfo(`Status update for untracked MessageSid: ${MessageSid} (Status: ${MessageStatus})`);
    }

    res.sendStatus(200); // Acknowledge the webhook
  } catch (error) {
    logError('Error processing status webhook:', error);
    res.sendStatus(500); // Ensure Twilio retries on failure
  }
});

export default router;
