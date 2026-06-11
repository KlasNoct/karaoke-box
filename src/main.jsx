import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import Uploader from './Uploader.jsx';
import './index.css';

const isUploader = window.location.pathname.startsWith('/uploader');

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {isUploader ? <Uploader /> : <App />}
  </React.StrictMode>
);
