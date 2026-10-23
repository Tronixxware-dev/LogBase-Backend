require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const { trustProxyValue, securityHeaders, noStore, corsOptions } = require('./utils/security');

const authRoutes = require('./routes/authRoutes');
const productRoutes = require('./routes/productRoutes');
const categoryRoutes = require('./routes/categoryRoutes');
const customerRoutes = require('./routes/customerRoutes');
const supplierRoutes = require('./routes/supplierRoutes');
const purchaseRoutes = require('./routes/purchaseRoutes');
const saleRoutes = require('./routes/saleRoutes');
const roleRoutes = require('./routes/roleRoutes');
const returnRoutes = require('./routes/returnRoutes');
const stockAdjustmentRoutes = require('./routes/stockAdjustmentRoutes');
const settingsRoutes = require('./routes/settingsRoutes');
const approvalRoutes = require('./routes/approvalRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const activityRoutes = require('./routes/activityRoutes');
const billingRoutes = require('./routes/billingRoutes');
const expenseRoutes = require('./routes/expenseRoutes');
const importRoutes = require('./routes/importRoutes');
const serialRoutes = require('./routes/serialRoutes');
const adminRoutes = require('./routes/adminRoutes');
const referralRoutes = require('./routes/referralRoutes');
const swapRoutes = require('./routes/swapRoutes');
const repairRoutes = require('./routes/repairRoutes');
const laundryRoutes = require('./routes/laundryRoutes');
const shopRoutes = require('./routes/shopRoutes');
const transferRoutes = require('./routes/transferRoutes');
const { startRenewalScheduler, stopRenewalScheduler } = require('./utils/renewals');

connectDB();

const app = express();

app.disable('x-powered-by');
// Behind a hosting proxy, set TRUST_PROXY=1 so each visitor has their own address (the login limits depend on it)
const trustProxy = trustProxyValue(process.env.TRUST_PROXY);
if (trustProxy !== false) app.set('trust proxy', trustProxy);

app.use(securityHeaders);
app.use(cors(corsOptions(process.env.CORS_ORIGIN)));
app.use('/api', noStore);
// The raw body is kept for the Paystack webhook only: its signature is calculated over the exact bytes sent.
app.use(
  express.json({
    verify: (req, res, buf) => {
      if (req.originalUrl.startsWith('/api/billing/webhook')) req.rawBody = buf;
    },
  })
);
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Reports whether the database is connected, so a monitor can tell "server up" from "server working".
app.get('/api/health', (req, res) => {
  const dbReady = mongoose.connection.readyState === 1;
  res.status(dbReady ? 200 : 503).json({ status: dbReady ? 'ok' : 'database-unavailable' });
});

app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/suppliers', supplierRoutes);
app.use('/api/purchases', purchaseRoutes);
app.use('/api/sales', saleRoutes);
app.use('/api/swaps', swapRoutes); // item swaps: the list (a swap is recorded as a sale with a trade-in)
app.use('/api/repairs', repairRoutes); // repair jobs
app.use('/api/laundry', laundryRoutes); // the laundry register and its list of clothing items
app.use('/api/shops', shopRoutes); // the stores of a business (the main store and any others)
app.use('/api/transfers', transferRoutes); // stock sent from one store to another
app.use('/api/roles', roleRoutes);
app.use('/api/returns', returnRoutes);
app.use('/api/stock-adjustments', stockAdjustmentRoutes);
app.use('/api/settings', settingsRoutes); // the business identity, preferences and approval policies
app.use('/api/approvals', approvalRoutes); // staff requests waiting for the administrator's OK
app.use('/api/notifications', notificationRoutes); // the bell: alerts and who wants which
app.use('/api/activity', activityRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/expenses', expenseRoutes);
app.use('/api/import', importRoutes);
app.use('/api/serials', serialRoutes);
app.use('/api/referral', referralRoutes); // a referrer's own code, referrals and earnings
app.use('/api/admin', adminRoutes); // the LogBase super-admin panel (SUPER_ADMIN_EMAILS only)

app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startRenewalScheduler(); // charges saved cards for plans set to renew automatically
});

// A redeploy sends SIGTERM: stop taking new requests, let running ones (a sale being saved) finish, then exit.
function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  stopRenewalScheduler();
  server.close(async () => {
    try {
      await mongoose.connection.close();
    } finally {
      process.exit(0);
    }
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));