export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    // The ledger palette from the M0 brief; colour carries exactly one meaning (refusal).
    colors: {
      ground: '#FBFAF5',
      ink: '#1C1E1A',
      muted: '#6B6F66',
      rule: '#CFD8CC',
      rule2: '#9AA595',
      stamp: '#B03A2E',
    },
    fontFamily: {
      sans: [
        'ui-sans-serif',
        'system-ui',
        '"Segoe UI"',
        'Roboto',
        'Helvetica',
        'Arial',
        'sans-serif',
      ],
      mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
    },
    extend: {},
  },
}
