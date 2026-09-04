import { createTheme } from '@mui/material/styles';
import { CATEGORY_COLORS } from './lib/icons';

/**
 * MUI theme mirroring the hand-written CSS custom properties in `styles.css`,
 * so the React Flow topology view and the card view read as one product rather
 * than two bolted together.
 */
export const theme = createTheme({
  palette: {
    mode: 'dark',
    background: {
      default: '#080b12',
      paper: '#131a27',
    },
    primary: {
      main: '#38bdf8',
      dark: '#0ea5e9',
      contrastText: '#04121c',
    },
    secondary: {
      main: '#818cf8',
    },
    success: { main: '#34d399' },
    warning: { main: '#fbbf24' },
    error: { main: '#f87171' },
    text: {
      primary: '#e6edf7',
      secondary: '#8899b0',
      disabled: '#5b6b83',
    },
    divider: '#212b3d',
  },

  shape: { borderRadius: 10 },

  typography: {
    fontFamily:
      "'Segoe UI', -apple-system, BlinkMacSystemFont, 'Inter', Roboto, Helvetica, Arial, sans-serif",
    fontSize: 14,
    button: { textTransform: 'none', fontWeight: 550 },
    caption: { fontSize: 11.5 },
  },

  components: {
    MuiPaper: {
      styleOverrides: {
        root: { backgroundImage: 'none', border: '1px solid #212b3d' },
      },
    },
    MuiTooltip: {
      styleOverrides: {
        tooltip: {
          backgroundColor: '#0f141f',
          border: '1px solid #2e3b52',
          fontSize: 12,
          maxWidth: 340,
        },
        arrow: { color: '#0f141f' },
      },
    },
    MuiToggleButton: {
      styleOverrides: {
        root: {
          borderColor: '#212b3d',
          color: '#8899b0',
          padding: '5px 12px',
          '&.Mui-selected': {
            backgroundColor: 'rgba(56, 189, 248, 0.14)',
            color: '#38bdf8',
            borderColor: '#38bdf8',
            '&:hover': { backgroundColor: 'rgba(56, 189, 248, 0.2)' },
          },
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: { fontWeight: 500 },
      },
    },
  },
});

/** MUI palette entries for each device category, for chips and avatars. */
export const categoryPalette = CATEGORY_COLORS;
