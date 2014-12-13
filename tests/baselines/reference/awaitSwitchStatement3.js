//// [awaitSwitchStatement3.ts]
declare class Promise<T> {
    constructor(init: (resolve: (value?: T | IPromise<T>) => void, reject: (reason?: any) => void) => void);
    then<TResult>(onfulfilled?: (value: T) => TResult | IPromise<TResult>, onrejected?: (reason: any) => TResult | IPromise<TResult>): Promise<TResult>;
}
declare var a: any;
declare var b: any;
declare var p: Promise<any>;
async function func(): Promise<void> {
    "before";
    switch (a) {
        case await p:
            "body0";
            break;
        case 1:
        default:
            "body1";
    }
    "after";
}

//// [awaitSwitchStatement3.js]
function func() {
    var _a;
    return new Promise(function (_resolve) {
        _resolve(__awaiter(__generator(function (_state) {
            switch (_state.label) {
                case 0:
                    "before";
                    _a = a;
                    return ["yield", p];
                case 1:
                    if (_a === _state.sent)
                        return ["break", 2];
                    switch (_a) {
                        case 1: return ["break", 3];
                    }
                    return ["break", 3];
                case 2:
                    "body0";
                    return ["break", 4];
                case 3:
                    "body1";
                    _state.label = 4;
                case 4:
                    "after";
                    return ["return"];
            }
        })));
    });
}
