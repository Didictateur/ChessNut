import Card from './card.js';

class Hand {
    constructor() {
        /** @type {Array(Card)} */
        this.cards = [];
    }

    /**
     * @param {Card} card 
     */
    pushCard(card) {
        this.cards.push(card);
    }

    /**
     * @param {number} index
     * @returns {Card|null}
     */
    popCard(index) {
        if (index < 0 || index >= this.cards.length) {
            return null;
        } else {
            let c = this.cards.at(index);
            this.cards.splice(index, 1);
            return c;
        }
    }
}

export default Hand;
