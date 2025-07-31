import mongoose from 'mongoose';

// Define the Message schema with comprehensive fields
const messageSchema = new mongoose.Schema({
  // Unique Twilio message identifier with index for fast lookups
  messageSid: { type: String, required: true, unique: true, index: true },
  // Salesforce contact ID for linking messages, indexed for queries
  contactId: { type: String, required: true, index: true },
  // Contact name, optional but indexed
  contactName: { type: String, index: true },
  // Message content, required unless using a template
  message: { type: String, required: function() { return !this.contentSid; } },
  // Twilio content SID for template messages
  contentSid: { type: String, index: true },
  // Variables for template messages
  contentVariables: { type: Object },
  // Sender's name
  fromName: { type: String, required: true },
  // Message direction (inbound/outbound)
  direction: { type: String, enum: ['inbound', 'outbound'], required: true },
  // Message status with predefined states
  status: { type: String, enum: ['queued', 'sending', 'sent', 'delivered', 'read', 'received', 'failed', 'undelivered'], default: 'queued' },
  // URL for status callback
  statusCallback: { type: String },
  // Read receipt flags
  isRead: { type: Boolean, default: false },
  readAt: { type: Date },
  // Media URLs array
  mediaUrl: [{ type: String }],
  // Sender and recipient numbers
  from: { type: String, required: true },
  to: { type: String, required: true },
  // Timestamps with indexes
  timestamp: { type: Date, default: Date.now, index: true },
  deliveredAt: { type: Date },
  sentAt: { type: Date },
  failedAt: { type: Date },
  // Additional channel metadata
  channelMetadata: { type: Object },
  // Error details
  errorCode: { type: String },
  errorMessage: { type: String },
  // Retry mechanism
  retryCount: { type: Number, default: 0 },
  maxRetries: { type: Number, default: 3 },
  nextRetryAt: { type: Date },
  // Message type
  messageType: { type: String, enum: ['text', 'template', 'media', 'location', 'contact', 'interactive'], default: 'text' }
});

// Export the Message model
export default mongoose.model('Message', messageSchema);