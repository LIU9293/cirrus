import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { App } from './App'
import { PublicRuntimeChat } from './pages/PublicRuntimeChat'

// Standalone shareable runtime chat: /r/<runtimeId> renders only the chat, with
// no app shell or login. Everything else goes through the normal app.
const publicMatch = window.location.pathname.match(/^\/r\/([^/]+)\/?$/)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {publicMatch ? <PublicRuntimeChat id={decodeURIComponent(publicMatch[1])} /> : <App />}
  </StrictMode>,
)
