import Card from './card.js';

class Stack {
    constructor() {
        /** @type {Array(Card)} */
        this.stack;
        /** @type {Array{Card}} */
        this.discard;
    }

    /**
     * @returns {Card|null}
     */
    drawACard() {
        if (this.stack.length > 0) {
            return this.stack.pop();
        } else {
            if (this.discard.length == 0) {
                return null;
            }
            while (this.discard.length > 0) {
                let randomIndex = Math.floor(Math.random() * this.discard.length);
                this.stack.push(this.discard.at(randomIndex));
                this.stack.splice(randomIndex, 1);
            }
            return this.stack.pop();
        }
    }

    /**
     * 
     * @param {card} card 
     */
    discardACard(card) {
        this.discard.push(card);
    }

    /**
     * @description Shuffle the stack
     */
    shuffle() {
        let index = this.stack.length - 1;
        while (index > 0) {
            let randomIndex = Math.floor(Math.random() * index);
            [this.stack[index], this.stack[randomIndex]] = [this.stack[randomIndex], this.stack[index]];
        }
    }
}

export default Stack;