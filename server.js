require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
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
const activityRoutes = require('./routes/activityRoutes');
const billingRoutes = require('./routes/billingRoutes');
const expenseRoutes = require('./routes/expenseRoutes');
const importRoutes = require('./routes/importRoutes');
const serialRoutes = require('./routes/serialRoutes');
const { startRenewalScheduler } = require('./utils/renewals');

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
app.use(morgan('dev'));

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/suppliers', supplierRoutes);
app.use('/api/purchases', purchaseRoutes);
app.use('/api/sales', saleRoutes);
app.use('/api/roles', roleRoutes);
app.use('/api/returns', returnRoutes);
app.use('/api/stock-adjustments', stockAdjustmentRoutes);
app.use('/api/activity', activityRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/expenses', expenseRoutes);
app.use('/api/import', importRoutes);
app.use('/api/serials', serialRoutes);

app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startRenewalScheduler(); // charges saved cards for plans set to renew automatically
});