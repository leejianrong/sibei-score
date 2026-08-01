import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';

const target = document.getElementById('app');
if (target === null) throw new Error('index.html is missing #app');

export default mount(App, { target });
