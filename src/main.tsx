import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ConfirmProvider } from './components/Confirm';
import { coreConfig, isCore } from './lib/core';
import { canonicalGameStudioNavigation } from './lib/canonical-navigation';
import './styles.css';
class ErrorBoundary extends React.Component<{children:React.ReactNode},{error:string}>{
  state={error:''};static getDerivedStateFromError(e:Error){return {error:e.message};}
  render(){if(this.state.error)return <main style={{padding:'3rem',fontFamily:'system-ui'}}><h1>Game Studio needs a little attention.</h1><p>{this.state.error}</p><a href="/">Reload the site</a></main>;return this.props.children;}
}
// Run before React mounts or any sign-in effect can create origin-scoped PKCE state.
const canonical = isCore && coreConfig ? canonicalGameStudioNavigation(location.href, coreConfig.redirect_uri, window.self !== window.top) : undefined;
if (canonical) location.replace(canonical);
else ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><ErrorBoundary><ConfirmProvider><App/></ConfirmProvider></ErrorBoundary></React.StrictMode>);
