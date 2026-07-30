import { style } from '@vanilla-extract/css';

import {
  colour,
  fontSize,
  fontWeight,
  hairline,
  radius,
  space,
  table as tableTokens
} from '../../styles/tokens.css';

export const staleBanner = style({
  margin: 0,
  marginTop: space[12],
  padding: `${space[8]} ${space[12]}`,
  borderRadius: radius.medium,
  backgroundColor: colour.surfaceElevated,
  border: `${hairline} solid ${colour.investigate}`,
  color: colour.investigateText,
  fontSize: fontSize.caption1,
  maxWidth: '620px'
});

export const haltBanner = style({
  margin: 0,
  marginTop: space[12],
  padding: `${space[12]} ${space[16]}`,
  borderRadius: radius.medium,
  border: `${hairline} solid ${colour.flag}`,
  color: colour.flag,
  fontSize: fontSize.subhead,
  maxWidth: '620px'
});

export const pairPicker = style({
  display: 'flex',
  gap: space[8],
  flexWrap: 'wrap',
  marginBottom: space[12]
});

const chipBase = {
  padding: `${space[4]} ${space[12]}`,
  borderRadius: radius.full,
  border: `${hairline} solid ${colour.border}`,
  background: 'none',
  fontSize: fontSize.caption1,
  fontWeight: fontWeight.semibold,
  color: colour.textPrimary,
  cursor: 'pointer',
  fontVariantNumeric: 'tabular-nums'
} as const;

export const pairChip = style(chipBase);

export const pairChipActive = style({
  ...chipBase,
  borderColor: colour.accent,
  color: colour.accent
});

export const zFigure = style({
  fontSize: fontSize.title2,
  fontWeight: fontWeight.semibold,
  color: colour.textPrimary,
  fontVariantNumeric: 'tabular-nums'
});

export const chartFrame = style({
  marginTop: space[12],
  marginBottom: space[8]
});

export const legsTable = style({
  borderCollapse: 'separate',
  borderSpacing: 0,
  minWidth: '420px'
});

export const imbalanceCell = style({
  padding: tableTokens.cellPadding,
  textAlign: 'right',
  borderBottom: `${hairline} solid ${colour.border}`,
  fontSize: fontSize.subhead,
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
  color: colour.investigateText,
  fontWeight: fontWeight.semibold
});

export const stats = style({
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
  gap: space[16],
  margin: 0,
  marginTop: space[16]
});

export const stat = style({
  display: 'flex',
  flexDirection: 'column',
  gap: space[4]
});

export const statLabel = style({
  fontSize: fontSize.caption1,
  color: colour.textSecondary
});

export const statValue = style({
  margin: 0,
  fontSize: fontSize.title3,
  fontWeight: fontWeight.semibold,
  fontVariantNumeric: 'tabular-nums'
});

export const statValueInvestigate = style([statValue, { color: colour.investigateText }]);

export const statValueFlag = style([statValue, { color: colour.flag }]);
