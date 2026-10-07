// Money maths shared by returns and statements. Amounts are kept to 2 decimals so repeated
// additions and subtractions never leave 0.0000001 behind.

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

// What happens to the money when `qty` of a sale line is returned.
//   line: { quantity, totalAmount, amountPaid, unitPrice }   (the line as it is now)
// Returns the value given back, how much of it only cancels money the customer still owed (nothing is
// handed back for that part), how much must be given back to the customer, and the line's new numbers.
function splitReturn(line, qty) {
  const quantity = Number(line.quantity);
  const total = round2(line.totalAmount);
  const paid = round2(line.amountPaid);
  const unitPrice = Number(line.unitPrice);

  // returning everything that is left gives back exactly what is left (no rounding drift)
  const value = qty === quantity ? total : Math.min(round2(qty * unitPrice), total);
  const owed = Math.max(round2(total - paid), 0);
  const owedReduction = Math.min(value, owed);
  const refund = round2(value - owedReduction);

  const newQuantity = round2(quantity - qty);
  const newTotal = round2(total - value);
  const newPaid = round2(paid - refund);

  let paymentStatus;
  if (newQuantity <= 0) paymentStatus = 'returned';
  else if (newPaid >= newTotal) paymentStatus = 'paid';
  else if (newPaid > 0) paymentStatus = 'partial';
  else paymentStatus = 'credit';

  return { value, owedReduction, refund, newQuantity, newTotal, newPaid, paymentStatus };
}

module.exports = { round2, splitReturn };
