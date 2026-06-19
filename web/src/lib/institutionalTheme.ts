export const institutionalTheme = {
  colors: {
    primary: '#1B5E38',
    secondary: '#D4EDDA',
    accent: '#2E7D52',
    background: '#F5F5F5',
    panelBackground: '#FFFFFF',
    text: {
      main: '#1A1A1A',
      muted: '#555555',
    },
    link: '#1B5E38',
    alert: {
      background: '#FFF8E1',
      border: '#FFC107',
    },
    borders: {
      default: '#CCCCCC',
      blue: '#A8D5B5',
    },
    status: {
      online: '#22c55e',
      degraded: '#eab308',
      offline: '#ef4444',
    }
  },
  typography: {
    fontFamily: 'Arial, Helvetica, sans-serif',
    baseSize: '14px',
  },
  shape: {
    borderRadius: '2px',
  }
} as const;
