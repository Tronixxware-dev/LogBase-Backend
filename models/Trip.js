const mongoose = require('mongoose');
const { historySchema } = require('./jobSchemas');

const EXPENSE_KINDS = ['fuel', 'toll', 'repair', 'allowance', 'parking', 'police', 'other'];

const expenseSchema = new mongoose.Schema({
  kind: { type: String, enum: EXPENSE_KINDS, default: 'other' },
  amount: { type: Number, required: true, min: 0.01 },
  note: { type: String, trim: true, maxlength: 120 },
  at: { type: Date, default: Date.now },
  byName: { type: String, trim: true },
});

// A run of a vehicle with a load (a haulage trip or a dispatch round): the shipments on it, what it cost to run, what it earned.
const tripSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    number: { type: Number, required: true },
    vehicle: { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle' },
    vehiclePlate: { type: String, trim: true },
    driver: { type: mongoose.Schema.Types.ObjectId, ref: 'Worker' },
    driverName: { type: String, trim: true },
    // what the driver earns for the trip (only the administrator sees it)
    driverPay: { type: Number, default: 0, min: 0 },
    from: { type: String, trim: true, maxlength: 80 },
    to: { type: String, trim: true, maxlength: 80 },
    status: { type: String, enum: ['planned', 'on_road', 'completed', 'cancelled'], default: 'planned' },
    history: [historySchema],
    plannedFor: { type: Date },
    startedAt: { type: Date },
    completedAt: { type: Date },
    expenses: [expenseSchema],
    distanceKm: { type: Number, default: 0, min: 0 },
    notes: { type: String, trim: true, maxlength: 500 },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    recordedByName: { type: String, trim: true },
  },
  { timestamps: true }
);

tripSchema.index({ business: 1, number: 1 }, { unique: true });
tripSchema.index({ business: 1, status: 1, createdAt: -1 });

const Trip = mongoose.model('Trip', tripSchema);
Trip.EXPENSE_KINDS = EXPENSE_KINDS;
module.exports = Trip;
