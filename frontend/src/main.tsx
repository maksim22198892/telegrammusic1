import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

const telegram = window.Telegram?.WebApp;
telegram?.ready();
telegram?.expand();
telegram?.setHeaderColor?.('#f7f7f5');
telegram?.setBackgroundColor?.('#f7f7f5');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>
);
