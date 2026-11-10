import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { installInputPolicy } from './input-policy'
import './global.css'

const root = document.getElementById('root')

if (!root) throw new Error('The application root is missing.')

const removeInputPolicy = installInputPolicy(document)
if (import.meta.hot) import.meta.hot.dispose(removeInputPolicy)

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
