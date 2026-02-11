/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx,html}",
    "./*.html"
  ],
  theme: {
    extend: {
      colors: {
primary: {
          DEFAULT: '#2E7D32',
          light: '#4CAF50',
          extralight: '#48c44e',
          bgicon: '#d0f5c5',
          bg: '#E8F5E9',
          
        },
        accent: '#FF9800',

        btn_logout: '#2E7D32',
        rice_green: '#1A9E48',     
        light_bg: '#F0F4F1',       
        btn_green: '#B9F6CA',      
        btn_light: '#C8E6C9',       
      },
      fontFamily: {
        sans: ['"Noto Sans Thai"', 'sans-serif'],
      }
    },
  },
  plugins: [],
}