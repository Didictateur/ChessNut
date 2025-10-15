import Effect from './effect.js';

class Card {
    constructor() {
        /** @type {string} */
        this.name;
        /** @type {string} */
        this.description;
        /** @type {Effect} */
        this.effect;
    }
}