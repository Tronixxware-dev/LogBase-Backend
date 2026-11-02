// The standard list of garments a tailor's shop starts with (prices are left at 0 for the owner to set), and the measurements each one needs.

const TOP = ['Neck', 'Shoulder', 'Chest', 'Waist', 'Hip', 'Top length', 'Sleeve length', 'Round sleeve', 'Wrist'];
const TROUSER = ['Trouser length', 'Thigh', 'Knee', 'Base'];
const LADY_TOP = ['Bust', 'Under bust', 'Waist', 'Hip', 'Shoulder', 'Nipple to nipple', 'Shoulder to bust', 'Sleeve length', 'Round sleeve'];

const STANDARD_STYLES = [
  { name: 'Agbada', measures: [...TOP, 'Agbada length', 'Agbada width', ...TROUSER] },
  { name: 'Senator (top & trouser)', measures: [...TOP, ...TROUSER] },
  { name: 'Kaftan', measures: ['Neck', 'Shoulder', 'Chest', 'Top length', 'Sleeve length', 'Round sleeve'] },
  { name: 'Native shirt (top only)', measures: TOP },
  { name: 'Trousers', measures: ['Waist', 'Hip', 'Trouser length', 'Thigh', 'Knee', 'Base', 'Crotch'] },
  { name: 'Shirt', measures: ['Neck', 'Shoulder', 'Chest', 'Waist', 'Top length', 'Sleeve length', 'Round sleeve', 'Wrist'] },
  { name: 'Suit (2 piece)', measures: ['Neck', 'Shoulder', 'Chest', 'Waist', 'Hip', 'Back', 'Top length', 'Sleeve length', 'Round sleeve', 'Trouser length', 'Thigh', 'Knee', 'Base', 'Crotch'] },
  { name: 'Iro & Buba', measures: [...LADY_TOP, 'Blouse length', 'Wrapper length'] },
  { name: 'Gown / dress', measures: [...LADY_TOP, 'Gown length'] },
  { name: 'Skirt & blouse', measures: [...LADY_TOP, 'Blouse length', 'Skirt length'] },
  { name: 'Skirt', measures: ['Waist', 'Hip', 'Skirt length'] },
  { name: 'Blouse', measures: ['Bust', 'Waist', 'Shoulder', 'Blouse length', 'Sleeve length', 'Round sleeve'] },
  { name: 'Jumpsuit', measures: [...LADY_TOP, 'Trouser length', 'Thigh'] },
  { name: 'School uniform', measures: ['Neck', 'Shoulder', 'Chest', 'Waist', 'Hip', 'Top length', 'Sleeve length', 'Trouser length'] },
  { name: 'Cap', measures: ['Head'] },
  { name: 'Alteration / mending', measures: [] },
];

module.exports = { STANDARD_STYLES };
