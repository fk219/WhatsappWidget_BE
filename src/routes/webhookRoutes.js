// import express from 'express';
// import bodyParser from 'body-parser';
// import Message from '../models/Message.js';
// import { logInfo, logError } from '../utils/logger.js';

// const router = express.Router();

// // Middleware to log all webhook requests
// router.use((req, res, next) => {
//   logInfo(`Webhook ${req.method} ${req.path} received`, { headers: req.headers, body: req.body });
//   next();
// });

// // Parse URL-encoded bodies
// router.use(bodyParser.urlencoded({ extended: false }));

// // Handle incoming messages
// router.post('/incoming', async (req, res) => {
//   try {
//     logInfo('Processing incoming message webhook', { body: req.body });
//     if (!req.body.MessageSid) {
//       logError('Missing required field: MessageSid', { body: req.body });
//       return res.status(400).send('Bad Request: Missing MessageSid');
//     }

//     const { MessageSid, From, To, Body, NumMedia, ProfileName, SmsStatus, WaId } = req.body;
//     const cleanFrom = From.replace('whatsapp:', '');
//     const cleanTo = To.replace('whatsapp:', '');
//     const contactName = ProfileName || cleanFrom;

//     let message = await Message.findOne({ messageSid: MessageSid });
//     if (!message) {
//       message = new Message({
//         messageSid: MessageSid,
//         contactId: cleanFrom,
//         waId: WaId,
//         message: Body,
//         direction: 'inbound',
//         status: SmsStatus || 'received',
//         from: cleanFrom,
//         fromName: contactName,
//         to: cleanTo,
//         contactName,
//         profileName: ProfileName,
//         mediaUrl: NumMedia > 0 ? `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages/${MessageSid}/Media` : null,
//         timestamp: new Date()
//       });
//       await message.save();
//       await Message.updateMany({ contactId: cleanFrom, contactName: { $in: [null, 'Unknown', ''] } }, { $set: { contactName } });
//     } else {
//       await Message.updateOne({ _id: message._id }, { $set: { status: SmsStatus || message.status, updatedAt: new Date(), profileName: ProfileName, contactName, fromName: ProfileName } });
//     }

//     const io = req.app.get('socketio');
//     if (io) io.to(`contact:${cleanFrom}`).emit('message:status', { messageId: message._id, messageSid: message.messageSid, status: message.status, timestamp: new Date() });

//     res.sendStatus(200);
//   } catch (error) {
//     logError('Error processing incoming webhook:', error);
//     res.sendStatus(500);
//   }
// });

// // Handle status updates
// router.post('/status', async (req, res) => {
//   try {
//     logInfo('Processing status webhook', { body: req.body });
//     if (!req.body.MessageSid) {
//       logError('Missing required field: MessageSid', { body: req.body });
//       return res.status(400).send('Bad Request: Missing MessageSid');
//     }

//     const { MessageSid, MessageStatus, ErrorCode, ErrorMessage } = req.body;
//     const updateData = { status: MessageStatus, updatedAt: new Date() };
//     if (MessageStatus === 'sent') updateData.sentAt = new Date();
//     else if (MessageStatus === 'delivered') updateData.deliveredAt = new Date();
//     else if (['failed', 'undelivered'].includes(MessageStatus)) {
//       updateData.failedAt = new Date();
//       updateData.errorCode = ErrorCode || 'DELIVERY_FAILED';
//       updateData.errorMessage = ErrorMessage || 'Message delivery failed';
//     } else if (MessageStatus === 'read') updateData.readAt = new Date();

//     await Message.updateOne({ messageSid: MessageSid }, { $set: updateData });
//     const message = await Message.findOne({ messageSid: MessageSid });
//     const io = req.app.get('socketio');
//     if (io && message) io.to(`contact:${message.contactId}`).emit('message:status', { messageId: message._id, messageSid, status: message.status, timestamp: new Date() });

//     res.sendStatus(200);
//   } catch (error) {
//     logError('Error processing status webhook:', error);
//     res.sendStatus(500);
//   }
// });

// export default router;

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
        timestamp: new Date(),
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
