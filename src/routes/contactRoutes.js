import express from 'express';
import Message from '../models/Message.js';
import { logInfo, logError } from '../utils/logger.js';

const router = express.Router();

/**
 * GET /contact/:recordId
 * Get contact details by recordId (contactId)
 * Returns the most recent contact information from message history
 * 
 * This endpoint is specifically designed to match the frontend expectation
 * of /api/contact/:recordId where recordId corresponds to contactId in the database
 */
router.get('/contact/:recordId', async (req, res) => {
  try {
    const { recordId } = req.params;

    // Input validation
    if (!recordId || typeof recordId !== 'string') {
      return res.status(400).json({ 
        success: false, 
        error: 'recordId is required and must be a string' 
      });
    }

    logInfo(`Fetching contact details for recordId: ${recordId}`);

    // Find the most recent message for this contact to get contact information
    const contactMessage = await Message.findOne({ 
      contactId: recordId.trim() 
    }).sort({ timestamp: -1 });

    if (contactMessage) {
      // Get total message count for this contact
      const messageCount = await Message.countDocuments({ 
        contactId: recordId.trim() 
      });

      // Determine the contact's phone number based on message direction
      let contactPhone;
      if (contactMessage.direction === 'inbound') {
        // For inbound messages, the contact's phone is in the 'from' field
        contactPhone = contactMessage.from;
      } else {
        // For outbound messages, the contact's phone is in the 'to' field
        contactPhone = contactMessage.to;
      }

      // Clean up the phone number (remove whatsapp: prefix if present)
      if (contactPhone && contactPhone.startsWith('whatsapp:')) {
        contactPhone = contactPhone.replace('whatsapp:', '');
      }

      const contactData = {
        contactId: recordId,
        name: contactMessage.contactName || contactMessage.fromName || 'Unknown Contact',
        phone: contactPhone,
        lastMessageDate: contactMessage.timestamp,
        messageCount: messageCount,
        lastMessageStatus: contactMessage.status,
        lastMessageDirection: contactMessage.direction
      };

      logInfo(`Contact found: ${recordId} - Name: ${contactData.name}, Phone: ${contactData.phone}`);
      
      return res.json({
        success: true,
        data: contactData
      });
    }

    // If no messages found for this contact, return a default contact structure
    logInfo(`No messages found for contact: ${recordId}, returning default contact data`);
    
    res.json({ 
      success: true,
      data: {
        contactId: recordId,
        name: 'Unknown Contact',
        phone: null,
        lastMessageDate: null,
        messageCount: 0,
        lastMessageStatus: null,
        lastMessageDirection: null
      }
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
 * Get all contacts with their latest message information
 * Useful for displaying a contact list
 * 
 * Query parameters:
 * - page: Page number (default: 1)
 * - limit: Number of contacts per page (default: 20, max: 100)
 */
router.get('/contacts', async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;

    // Input validation
    const pageNum = parseInt(page);
    const limitNum = Math.min(parseInt(limit), 100); // Cap limit at 100

    if (pageNum < 1 || limitNum < 1) {
      return res.status(400).json({ 
        success: false, 
        error: 'Page and limit must be positive integers' 
      });
    }

    logInfo(`Fetching contacts - Page: ${pageNum}, Limit: ${limitNum}`);

    // Aggregate to get unique contacts with their latest message
    const pipeline = [
      {
        $sort: { timestamp: -1 }
      },
      {
        $group: {
          _id: '$contactId',
          latestMessage: { $first: '$$ROOT' },
          messageCount: { $sum: 1 },
          lastMessageDate: { $first: '$timestamp' }
        }
      },
      {
        $sort: { lastMessageDate: -1 }
      },
      {
        $skip: (pageNum - 1) * limitNum
      },
      {
        $limit: limitNum
      }
    ];

    const [contacts, totalContacts] = await Promise.all([
      Message.aggregate(pipeline),
      Message.distinct('contactId').then(contactIds => contactIds.length)
    ]);

    // Format the response
    const formattedContacts = contacts.map(contact => {
      const message = contact.latestMessage;
      
      // Determine contact phone based on message direction
      let contactPhone;
      if (message.direction === 'inbound') {
        contactPhone = message.from;
      } else {
        contactPhone = message.to;
      }

      // Clean up phone number
      if (contactPhone && contactPhone.startsWith('whatsapp:')) {
        contactPhone = contactPhone.replace('whatsapp:', '');
      }

      return {
        contactId: contact._id,
        name: message.contactName || message.fromName || 'Unknown Contact',
        phone: contactPhone,
        lastMessageDate: contact.lastMessageDate,
        messageCount: contact.messageCount,
        lastMessageStatus: message.status,
        lastMessageDirection: message.direction,
        lastMessagePreview: message.message ? message.message.substring(0, 100) : 'Media message'
      };
    });

    const totalPages = Math.ceil(totalContacts / limitNum);

    logInfo(`Retrieved ${formattedContacts.length} contacts out of ${totalContacts} total`);

    res.json({
      success: true,
      data: formattedContacts,
      pagination: { 
        total: totalContacts,
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
 * Global error handler for the contact router
 * Catches any unhandled errors and returns a consistent error response
 */
router.use((error, req, res, next) => {
  logError('Unhandled error in contact routes:', error);
  
  if (!res.headersSent) {
    res.status(500).json({
      success: false,
      error: 'An unexpected error occurred in contact routes',
      requestId: req.headers['x-request-id'] || 'unknown'
    });
  }
});

export default router;
