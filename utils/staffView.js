// Only the owner sees what things cost the business (cost prices, purchase costs, delivery fees), and only
// people allowed to manage customers see what customers owe. These helpers remove those fields from what is
// sent to everyone else. The owner always gets the full records.

const { can, canSeeCosts } = require('./permissions');

function isOwner(req) {
  return Boolean(req.user) && req.user.role === 'owner';
}

function plain(doc) {
  return doc && typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
}

// A product without its cost prices (also on every colour / size).
function hideProductCosts(product) {
  const out = plain(product);
  delete out.costPrice;
  if (Array.isArray(out.variants)) {
    out.variants = out.variants.map((variant) => {
      const copy = { ...variant };
      delete copy.costPrice;
      return copy;
    });
  }
  return out;
}

function productForUser(req, product) {
  return canSeeCosts(req.user) ? product : hideProductCosts(product);
}

function productsForUser(req, products) {
  return canSeeCosts(req.user) ? products : products.map(hideProductCosts);
}

// A purchase line without what it cost (unit cost, total and delivery fee).
function hidePurchaseCosts(purchase) {
  const out = plain(purchase);
  delete out.costPricePerUnit;
  delete out.totalCost;
  delete out.deliveryCost;
  delete out.deliveryPaidByUs;
  delete out.amountPaid;
  delete out.creditAmount;
  delete out.onCredit;
  return out;
}

// Anyone who is not the administrator sees nothing about suppliers: who the goods came from, or whether they were paid for.
function hideSupplierInfo(purchase) {
  const out = plain(purchase);
  delete out.supplier;
  delete out.supplierName;
  return out;
}

function purchaseForUser(req, purchase) {
  return canSeeCosts(req.user) ? purchase : hideSupplierInfo(hidePurchaseCosts(purchase));
}

function purchasesForUser(req, purchases) {
  return canSeeCosts(req.user) ? purchases : purchases.map((p) => hideSupplierInfo(hidePurchaseCosts(p)));
}

// A sale line without the delivery fee the business paid.
function hideSaleCosts(sale) {
  const out = plain(sale);
  delete out.deliveryCost;
  delete out.deliveryPaidByUs;
  return out;
}

function saleForUser(req, sale) {
  return canSeeCosts(req.user) ? sale : hideSaleCosts(sale);
}

function salesForUser(req, sales) {
  return canSeeCosts(req.user) ? sales : sales.map(hideSaleCosts);
}

// A return without what the units that did not go back on the shelf cost the business.
function hideReturnCosts(ret) {
  const out = plain(ret);
  delete out.writtenOffCost;
  if (Array.isArray(out.items)) {
    out.items = out.items.map((item) => {
      const copy = { ...item };
      delete copy.writtenOffCost;
      return copy;
    });
  }
  return out;
}

function returnForUser(req, ret) {
  return canSeeCosts(req.user) ? ret : hideReturnCosts(ret);
}

function returnsForUser(req, returns) {
  return canSeeCosts(req.user) ? returns : returns.map(hideReturnCosts);
}

// A stock adjustment without what the lost or found units were worth.
function hideAdjustmentCosts(adjustment) {
  const out = plain(adjustment);
  delete out.costValue;
  return out;
}

function adjustmentsForUser(req, adjustments) {
  return canSeeCosts(req.user) ? adjustments : adjustments.map(hideAdjustmentCosts);
}

function adjustmentForUser(req, adjustment) {
  return canSeeCosts(req.user) ? adjustment : hideAdjustmentCosts(adjustment);
}

// A customer without the amount they owe.
function hideCustomerBalance(customer) {
  const out = plain(customer);
  delete out.balance;
  return out;
}

function customerForUser(req, customer) {
  return can(req.user, 'manageCustomers') ? customer : hideCustomerBalance(customer);
}

function customersForUser(req, customers) {
  return can(req.user, 'manageCustomers') ? customers : customers.map(hideCustomerBalance);
}

// A supplier without what the business owes them (only the owner sees that).
function hideSupplierBalance(supplier) {
  const out = plain(supplier);
  delete out.balance;
  delete out.openingBalance;
  return out;
}

function supplierForUser(req, supplier) {
  return canSeeCosts(req.user) ? supplier : hideSupplierBalance(supplier);
}

function suppliersForUser(req, suppliers) {
  return canSeeCosts(req.user) ? suppliers : suppliers.map(hideSupplierBalance);
}

module.exports = {
  isOwner,
  supplierForUser,
  suppliersForUser,
  productForUser,
  productsForUser,
  purchaseForUser,
  purchasesForUser,
  saleForUser,
  salesForUser,
  returnForUser,
  returnsForUser,
  adjustmentForUser,
  adjustmentsForUser,
  customerForUser,
  customersForUser,
};
